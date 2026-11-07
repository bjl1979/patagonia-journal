// Cloud sync with Supabase (plain fetch, no library, so it keeps working offline).
// Offline-first: every change is saved on the phone and marked `dirty`; when there is signal
// the phone pushes its changes, uploads files, then pulls what the other phone sent.
// Conflicts: the newer `updated` wins. Deletes are kept as tombstones so they sync too.

const Sync = (() => {
  const configured = () => !!(CLOUD.url && CLOUD.key);
  let session = null;      // { access_token, refresh_token, expires_at, user: {id, email} }
  let running = null;      // promise of the sync in progress
  let again = false;
  let listeners = [];
  const state = { status: 'idle', lastSync: null, pending: 0, error: null };

  const emit = () => listeners.forEach(fn => fn({ ...state, signedIn: !!session, email: session?.user?.email, configured: configured() }));
  const set = (patch) => { Object.assign(state, patch); emit(); };

  // ---------- auth ----------
  async function authCall(path, body) {
    const res = await fetch(`${CLOUD.url}/auth/v1/${path}`, {
      method: 'POST', headers: { apikey: CLOUD.key, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.error_description || json.msg || json.message || `Sign-in failed (${res.status})`), { status: res.status });
    return json;
  }
  async function saveSession(j) {
    session = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000, user: { id: j.user.id, email: j.user.email } };
    await DB.setSetting('cloudSession', session);
  }
  async function signIn(email, password) {
    await saveSession(await authCall('token?grant_type=password', { email, password }));
    await DB.setSetting('cloudCursor', null);
    emit();
    return run({ full: true });
  }
  async function signOut() {
    session = null; await DB.setSetting('cloudSession', null); emit();
  }
  async function token() {
    if (!session) throw new Error('Not signed in');
    if (Date.now() > session.expires_at - 120000) {
      try { await saveSession(await authCall('token?grant_type=refresh_token', { refresh_token: session.refresh_token })); }
      catch (e) {
        if (e.status === 400 || e.status === 401) { await signOut(); throw new Error('Signed out — please sign in again'); }
        throw e;
      }
    }
    return session.access_token;
  }
  async function api(path, opts = {}) {
    const res = await fetch(`${CLOUD.url}${path}`, {
      ...opts, headers: { apikey: CLOUD.key, Authorization: `Bearer ${await token()}`, ...(opts.headers || {}) },
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Cloud error ${res.status}: ${t.slice(0, 140)}`);
    }
    return res;
  }

  // ---------- helpers ----------
  const EXT = { 'image/jpeg': 'jpg', 'audio/mp4': 'm4a', 'audio/webm': 'webm', 'audio/ogg': 'ogg' };
  const pathFor = (m) => `${session.user.id}/${m.id}.${EXT[(m.mime || '').split(';')[0]] || 'bin'}`;
  const metaOf = (m) => { const { blob, thumb, dirty, uploaded, offloaded, needsDownload, ...meta } = m; return meta; };
  const entryData = (e) => { const { dirty, ...data } = e; return data; };

  async function countPending() {
    const [es, ms] = await Promise.all([DB.all('entries'), DB.all('media')]);
    return es.filter(e => e.dirty).length + ms.filter(m => m.dirty).length;
  }

  // ---------- push ----------
  async function pushEntries() {
    const dirty = (await DB.all('entries')).filter(e => e.dirty);
    for (let i = 0; i < dirty.length; i += 200) {
      const batch = dirty.slice(i, i + 200);
      await api('/rest/v1/entries?on_conflict=id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(batch.map(e => ({ id: e.id, user_id: session.user.id, data: entryData(e), updated: e.updated || 0, deleted: !!e.deleted }))),
      });
      for (const e of batch) {
        const cur = await DB.get('entries', e.id);
        if (cur && (cur.updated || 0) === (e.updated || 0)) { cur.dirty = false; await DB.put('entries', cur); }
      }
    }
  }

  async function pushMedia() {
    const dirty = (await DB.all('media')).filter(m => m.dirty);
    for (const m of dirty) {
      const path = pathFor(m);
      if (m.deleted) {
        await api(`/storage/v1/object/${CLOUD.bucket}`, {
          method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: [path] }),
        }).catch(() => {});
      } else if (!m.uploaded && m.blob) {
        set({ status: 'uploading' });
        await api(`/storage/v1/object/${CLOUD.bucket}/${path}`, {
          method: 'POST', headers: { 'Content-Type': (m.mime || 'application/octet-stream').split(';')[0], 'x-upsert': 'true' }, body: m.blob,
        });
      }
      await api('/rest/v1/media?on_conflict=id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{ id: m.id, user_id: session.user.id, entry_id: m.entryId, data: metaOf(m), path, updated: m.updated || m.takenAt || 0, deleted: !!m.deleted }]),
      });
      const cur = await DB.get('media', m.id);
      if (cur) { cur.dirty = false; if (!cur.deleted) cur.uploaded = true; await DB.put('media', cur); }
      set({ pending: Math.max(0, state.pending - 1) });
    }
  }

  // ---------- pull ----------
  async function pullTable(table, since) {
    const rows = [];
    let offset = 0;
    for (;;) {
      const q = `select=*&order=server_ts.asc,id.asc&limit=1000&offset=${offset}` + (since ? `&server_ts=gt.${encodeURIComponent(since)}` : '');
      const page = await (await api(`/rest/v1/${table}?${q}`)).json();
      rows.push(...page);
      if (page.length < 1000) break;
      offset += 1000;
    }
    return rows;
  }

  async function download(path) {
    const res = await api(`/storage/v1/object/authenticated/${CLOUD.bucket}/${path}`);
    return res.blob();
  }

  async function pull(full) {
    const cursor = full ? null : await DB.setting('cloudCursor', null);
    // small overlap so rows committed out of order are never missed (merging is idempotent)
    const since = cursor ? new Date(new Date(cursor).getTime() - 10000).toISOString() : null;
    const [eRows, mRows] = [await pullTable('entries', since), await pullTable('media', since)];
    let newest = cursor, changed = 0;

    for (const r of eRows) {
      const local = await DB.get('entries', r.id);
      if (!local || ((r.updated || 0) > (local.updated || 0) && !(local.dirty && (local.updated || 0) >= r.updated))) {
        await DB.put('entries', { ...r.data, id: r.id, updated: r.updated, deleted: r.deleted, dirty: false });
        changed++;
      }
      if (!newest || r.server_ts > newest) newest = r.server_ts;
    }
    for (const r of mRows) {
      const local = await DB.get('media', r.id);
      if (r.deleted) {
        if (local && !local.deleted) { await DB.put('media', { ...metaOf(local), id: r.id, deleted: true, dirty: false }); changed++; }
      } else if (!local) {
        await DB.put('media', { ...r.data, id: r.id, entryId: r.entry_id, path: r.path, uploaded: true, dirty: false, needsDownload: true });
        changed++;
      }
      if (!newest || r.server_ts > newest) newest = r.server_ts;
    }
    if (newest) await DB.setSetting('cloudCursor', newest);
    return changed;
  }

  async function downloadMissing() {
    const need = (await DB.all('media')).filter(m => m.needsDownload && !m.deleted);
    let n = 0;
    for (const m of need) {
      set({ status: 'downloading' });
      try {
        const blob = await download(m.path || pathFor(m));
        const cur = await DB.get('media', m.id);
        if (cur && !cur.deleted) { cur.blob = blob; cur.needsDownload = false; await DB.put('media', cur); n++; }
      } catch (e) { if (!navigator.onLine) break; }
    }
    return n;
  }

  // ---------- main loop ----------
  async function doRun({ full } = {}) {
    if (!configured() || !session) { set({ status: 'idle', pending: await countPending() }); return 0; }
    if (!navigator.onLine) { set({ status: 'offline', pending: await countPending() }); return 0; }
    set({ status: 'syncing', error: null, pending: await countPending() });
    try {
      await pushEntries();
      await pushMedia();
      const changed = await pull(full);
      const got = await downloadMissing();
      const lastSync = Date.now();
      await DB.setSetting('lastSync', lastSync);
      set({ status: 'synced', lastSync, pending: await countPending() });
      return changed + got;
    } catch (e) {
      set({ status: navigator.onLine ? 'error' : 'offline', error: e.message, pending: await countPending() });
      return 0;
    }
  }

  function run(opts) {
    if (running) { again = true; return running; }
    running = doRun(opts).then(async (n) => {
      if (n) onChange();
      running = null;
      if (again) { again = false; return run(); }
      return n;
    });
    return running;
  }

  let onChange = () => {};
  let debounce;
  const soon = () => { clearTimeout(debounce); debounce = setTimeout(() => run(), 2500); countPending().then(pending => set({ pending })); };

  // ---------- free up space (photos only) ----------
  async function freeUpSpace() {
    const media = (await DB.all('media')).filter(m => m.kind === 'photo' && m.blob && m.uploaded && !m.dirty && !m.deleted);
    let saved = 0;
    for (const m of media) {
      const thumb = await U.resizeImage(m.blob, 480, 0.7);
      saved += m.blob.size - thumb.size;
      await DB.put('media', { ...m, blob: null, thumb, offloaded: true });
    }
    return { count: media.length, saved };
  }

  // Full-size blob for a photo whose full copy was freed from the phone.
  async function fullBlob(m) {
    if (m.blob) return m.blob;
    if (!configured() || !session || !navigator.onLine) return m.thumb || null;
    try { return await download(m.path || pathFor(m)); } catch { return m.thumb || null; }
  }

  async function init(changeHandler) {
    onChange = changeHandler || onChange;
    session = await DB.setting('cloudSession', null);
    state.lastSync = await DB.setting('lastSync', null);
    state.pending = await countPending();
    emit();
    addEventListener('online', () => run());
    addEventListener('offline', () => set({ status: 'offline' }));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') run(); });
    setInterval(() => { if (document.visibilityState === 'visible') run(); }, 5 * 60 * 1000);
    run();
  }

  return {
    init, run, soon, signIn, signOut, freeUpSpace, fullBlob, configured,
    subscribe: (fn) => { listeners.push(fn); emit(); },
    get state() { return { ...state, signedIn: !!session, email: session?.user?.email, configured: configured() }; },
  };
})();
