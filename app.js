// Field Journal — offline travel diary. Phase 1: capture. Phase 2 (later): book builder.
const APP_VERSION = '1.1.0';
const SPECIES = [
  'Puma', 'Guanaco', 'Andean Condor', "Darwin's Rhea (Ñandú)", 'Huemul', 'Culpeo Fox',
  'South American Grey Fox', 'Patagonian Hog-nosed Skunk', 'Pichi (Armadillo)', 'Magellanic Penguin',
  'King Penguin', 'Gentoo Penguin', 'Black-browed Albatross', 'Southern Crested Caracara',
  'Chimango Caracara', 'Black-chested Buzzard-Eagle', 'Magellanic Woodpecker', 'Austral Parakeet',
  'Torrent Duck', 'Upland Goose', 'Ashy-headed Goose', 'Black-necked Swan', 'Coscoroba Swan',
  'Chilean Flamingo', 'Great Grebe', 'Silvery Grebe', 'Hooded Grebe', 'Rufous-collared Sparrow',
  'Austral Thrush', 'Southern Lapwing', 'Magellanic Oystercatcher', 'Imperial Cormorant',
  'South American Sea Lion', 'Southern Elephant Seal', 'Southern Right Whale', 'Orca',
  "Commerson's Dolphin", "Peale's Dolphin", 'Mara (Patagonian Hare)', 'Lesser Grison',
];
const QUICK_SPECIES = ['Puma', 'Guanaco', 'Andean Condor', "Darwin's Rhea (Ñandú)", 'Culpeo Fox', 'Huemul', 'Magellanic Penguin', 'Southern Crested Caracara'];

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
let settings = {};
let urls = [];            // object URLs on the page, revoked on re-render
let editor = null;        // current entry being edited

// ---------------- time helpers ----------------
const deviceTZ = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
function dayKey(ms, tz) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  return p; // YYYY-MM-DD
}
const fmtTime = (ms, tz) => new Date(ms).toLocaleTimeString([], { timeZone: tz, hour: '2-digit', minute: '2-digit' });
const fmtDay = (key) => new Date(key + 'T12:00:00').toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
function tripDay(key) {
  if (!settings.tripStart) return null;
  const d = Math.round((new Date(key + 'T12:00:00') - new Date(settings.tripStart + 'T12:00:00')) / 864e5) + 1;
  return d >= 1 ? d : null;
}

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
function trackURL(blob) { const u = URL.createObjectURL(blob); urls.push(u); return u; }

// ---------------- boot ----------------
async function boot() {
  settings.deviceName = await DB.setting('deviceName', /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android' : 'Phone');
  settings.tripStart = await DB.setting('tripStart', '2026-11-30');
  settings.tripName = await DB.setting('tripName', 'Patagonia');
  settings.lastBackup = await DB.setting('lastBackup', null);

  $('#deviceName').value = settings.deviceName;
  $('#tripStart').value = settings.tripStart;
  $('#tripName').value = settings.tripName;
  for (const [id, key] of [['#deviceName', 'deviceName'], ['#tripStart', 'tripStart'], ['#tripName', 'tripName']]) {
    $(id).addEventListener('change', async (e) => { settings[key] = e.target.value.trim(); await DB.setSetting(key, settings[key]); renderAll(); });
  }

  $('#speciesSuggest').innerHTML = SPECIES.map(s => `<option value="${U.esc(s)}">`).join('');
  $$('.tab').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
  $$('.cap').forEach(b => b.addEventListener('click', () => openEditor(null, b.dataset.mode)));
  wireEditor();
  wireBackup();
  updateNet();
  addEventListener('online', updateNet); addEventListener('offline', updateNet);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  renderAll();
}

function updateNet() {
  const b = $('#netBadge');
  b.classList.toggle('off', !navigator.onLine);
  b.textContent = navigator.onLine ? '● online' : '● offline — all good';
}

function showView(v) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === v));
  $$('.view').forEach(s => s.classList.toggle('active', s.id === 'view-' + v));
  $('#captureBar').style.display = v === 'settings' ? 'none' : '';
  if (v === 'settings') renderStorage();
}

// ---------------- rendering ----------------
async function renderAll() {
  urls.forEach(URL.revokeObjectURL); urls = [];
  const entries = (await DB.all('entries')).sort((a, b) => b.at - a.at);
  const media = await DB.all('media');
  const byEntry = {};
  for (const m of media) (byEntry[m.entryId] ||= []).push(m);

  // header
  const todayKey = dayKey(Date.now(), deviceTZ());
  const td = tripDay(todayKey);
  $('#tripLine').textContent = `${settings.tripName || 'Trip'} · Field Journal`;
  $('#dayTitle').textContent = td ? `Day ${td}` : (settings.tripStart > todayKey ? `${Math.ceil((new Date(settings.tripStart) - new Date(todayKey)) / 864e5)} days to go` : 'Field Journal');

  renderTimeline(entries, byEntry);
  renderSpecies(entries, media);
  renderBackupInfo(entries.length);
}

function renderTimeline(entries, byEntry) {
  const el = $('#timeline');
  if (!entries.length) {
    el.innerHTML = `<div class="empty"><h2>Your journal starts here</h2>
      <p>Tap <b>Voice</b>, <b>Photo</b> or <b>Note</b> below. Every entry gets the time and your GPS position automatically — no signal needed.</p></div>`;
    return;
  }
  const groups = new Map();
  for (const e of entries) {
    const k = dayKey(e.at, e.tz);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  let html = '';
  for (const [k, list] of groups) {
    const td = tripDay(k);
    const species = new Set(list.flatMap(e => e.species || []));
    html += `<div class="day"><h2>${td ? 'Day ' + td : U.esc(fmtDay(k))}</h2>
      <span class="sub">${td ? U.esc(fmtDay(k)) + ' · ' : ''}${list.length} entr${list.length > 1 ? 'ies' : 'y'}${species.size ? ' · ' + species.size + ' species' : ''}</span></div>`;
    for (const e of list) {
      const m = byEntry[e.id] || [];
      const photos = m.filter(x => x.kind === 'photo' && !x.species);
      const idPhoto = (s) => m.find(x => x.kind === 'photo' && x.species === s);
      const audio = m.filter(x => x.kind === 'audio');
      html += `<article class="entry" data-id="${e.id}">
        <div class="when"><span>${fmtTime(e.at, e.tz)}</span>${e.place ? `<span class="place">${U.esc(e.place)}</span>` : ''}${e.lat != null ? `<span>📍${e.lat.toFixed(3)}, ${e.lon.toFixed(3)}</span>` : ''}${e.device ? `<span>· ${U.esc(e.device)}</span>` : ''}</div>
        ${e.text ? `<p class="text">${U.esc(e.text)}</p>` : ''}
        ${photos.length ? `<div class="thumbs">${photos.map(p => `<img src="${trackURL(p.blob)}" alt="" loading="lazy">`).join('')}</div>` : ''}
        ${audio.map(a => `<audio controls preload="none" src="${trackURL(a.blob)}"></audio>`).join('')}
        ${(e.species || []).length ? `<div class="chips tags">${e.species.map(s => { const p = idPhoto(s); return `<span class="chip${p ? ' has-av' : ''}">${p ? `<img class="av" src="${trackURL(p.blob)}" alt="">` : ''}${U.esc(s)}</span>`; }).join('')}</div>` : ''}
      </article>`;
    }
  }
  el.innerHTML = html;
  el.querySelectorAll('.entry').forEach(a => a.addEventListener('click', (ev) => {
    if (ev.target.closest('audio')) return;
    openEditor(a.dataset.id);
  }));
}

function renderSpecies(entries, media = []) {
  const live = new Set(entries.map(e => e.id));
  const idPhotos = {};
  for (const m of media) if (m.kind === 'photo' && m.species && live.has(m.entryId)) (idPhotos[m.species] ||= []).push(m);
  Object.values(idPhotos).forEach(l => l.sort((a, b) => b.takenAt - a.takenAt));
  speciesGallery = idPhotos;
  const tally = new Map();
  for (const e of [...entries].sort((a, b) => a.at - b.at)) {
    for (const s of e.species || []) {
      const t = tally.get(s) || { n: 0, first: e, places: new Set() };
      t.n++; if (e.place) t.places.add(e.place);
      tally.set(s, t);
    }
  }
  const el = $('#speciesList');
  if (!tally.size) { el.innerHTML = `<div class="empty"><h2>No sightings yet</h2><p>Tag species on any entry and your life list builds itself here. Tap 📷 on a species tag to add an ID photo.</p></div>`; return; }
  el.innerHTML = `<p class="muted">${tally.size} species logged</p>` + [...tally.entries()]
    .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))
    .map(([s, t]) => {
      const k = dayKey(t.first.at, t.first.tz), td = tripDay(k);
      const ph = idPhotos[s] || [];
      return `<div class="sp-row" data-s="${U.esc(s)}">
        ${ph.length ? `<img class="sp-thumb" src="${trackURL(ph[0].blob)}" alt="">` : '<span class="sp-thumb none">🐾</span>'}
        <div class="sp-info"><div class="n">${U.esc(s)}</div>
        <div class="d">First: ${td ? 'Day ' + td : U.esc(fmtDay(k))}${t.first.place ? ' · ' + U.esc(t.first.place) : ''}${ph.length ? ` · ${ph.length} ID photo${ph.length > 1 ? 's' : ''}` : ''}</div></div>
        <span class="sp-count">${t.n}</span></div>`;
    }).join('');
  el.querySelectorAll('.sp-row').forEach(r => r.addEventListener('click', () => openGallery(r.dataset.s)));
}

let speciesGallery = {};
function openGallery(species) {
  const list = speciesGallery[species] || [];
  if (!list.length) { toast('No ID photos yet — open an entry and tap 📷 on this species'); return; }
  const v = $('#viewer');
  v.innerHTML = `<div class="viewer-head"><strong>${U.esc(species)}</strong><button class="link" id="viewerClose">Close</button></div>
    <div class="viewer-grid">${list.map(m => `<figure><img src="${trackURL(m.blob)}" alt=""><figcaption>${new Date(m.takenAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</figcaption></figure>`).join('')}</div>`;
  v.hidden = false; document.documentElement.classList.add('sheet-open');
  $('#viewerClose').addEventListener('click', () => { v.hidden = true; v.innerHTML = ''; document.documentElement.classList.remove('sheet-open'); });
}

function renderBackupInfo(count) {
  const lb = settings.lastBackup;
  $('#lastBackup').textContent = `${count} entr${count === 1 ? 'y' : 'ies'} on this phone · ` +
    (lb ? 'last backup ' + new Date(lb).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'no backup yet');
}

async function renderStorage() {
  if (!navigator.storage?.estimate) return;
  const { usage, quota } = await navigator.storage.estimate();
  const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
  $('#storageInfo').textContent = `Using ${(usage / 1048576).toFixed(1)} MB of ~${(quota / 1073741824).toFixed(1)} GB available · ${persisted ? 'protected from auto-cleanup' : 'not yet protected from auto-cleanup'} · v${APP_VERSION}`;
}

// ---------------- editor ----------------
function wireEditor() {
  $('#cancelBtn').addEventListener('click', closeEditor);
  $('#sheetBackdrop').addEventListener('click', closeEditor);
  $('#saveBtn').addEventListener('click', saveEditor);
  $('#saveBtn2').addEventListener('click', saveEditor);
  $('#deleteBtn').addEventListener('click', deleteEntry);
  $('#cameraInput').addEventListener('change', (e) => addPhotos(e.target.files, e.target));
  $('#galleryInput').addEventListener('change', (e) => addPhotos(e.target.files, e.target));
  $('#speciesPhotoInput').addEventListener('change', (e) => { if (editor?.photoForSpecies) addPhotos(e.target.files, e.target, editor.photoForSpecies); });
  $('#recBtn').addEventListener('click', toggleRecord);
  $('#addSpeciesBtn').addEventListener('click', () => addSpecies($('#speciesInput').value));
  $('#speciesInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addSpecies(e.target.value); } });
}

async function openEditor(id, mode) {
  const isNew = !id;
  const entry = isNew
    ? { id: U.uid(), at: Date.now(), tz: deviceTZ(), offsetMin: -new Date().getTimezoneOffset(), device: settings.deviceName, text: '', species: [], place: '', lat: null, lon: null, created: Date.now() }
    : await DB.get('entries', id);
  const existing = isNew ? [] : await DB.mediaFor(id);
  editor = { entry: { ...entry, species: [...(entry.species || [])] }, isNew, existing, added: [], removed: new Set(), editorURLs: [], recorder: null };

  if (isNew) {
    const last = (await DB.all('entries')).sort((a, b) => b.at - a.at)[0];
    if (last && Date.now() - last.at < 3 * 3600e3) editor.entry.place = editor.carriedPlace = last.place || ''; // carry place forward
  }

  $('#sheetTitle').textContent = isNew ? 'New entry' : 'Edit entry';
  $('#textInput').value = editor.entry.text || '';
  $('#placeInput').value = editor.entry.place || '';
  $('#speciesInput').value = '';
  $('#deleteBtn').hidden = isNew;
  $('#whenText').textContent = new Date(editor.entry.at).toLocaleString([], { timeZone: editor.entry.tz, dateStyle: 'medium', timeStyle: 'short' });
  renderEditorMedia(); renderChips(); setGPSText();
  $('#sheetBackdrop').hidden = false; $('#sheet').hidden = false;
  document.documentElement.classList.add('sheet-open'); $('.sheet-body').scrollTop = 0;

  if (isNew) locate();
  if (mode === 'photo') $('#cameraInput').click();
  else if (mode === 'voice') toggleRecord();
  else if (mode === 'note') setTimeout(() => $('#textInput').focus(), 50);
}

function closeEditor() {
  if (editor?.recorder) { editor.discardRecording = true; editor.recorder.stop(); }
  editor?.editorURLs.forEach(URL.revokeObjectURL);
  editor = null;
  $('#sheet').hidden = true; $('#sheetBackdrop').hidden = true;
  document.documentElement.classList.remove('sheet-open');
}

function setGPSText(state) {
  const g = $('#gpsText'), e = editor.entry;
  g.classList.remove('ok');
  if (e.lat != null) { g.textContent = `📍 ${e.lat.toFixed(4)}, ${e.lon.toFixed(4)}${e.acc ? ' ±' + Math.round(e.acc) + 'm' : ''}`; g.classList.add('ok'); }
  else g.textContent = state || (editor.isNew ? 'Locating…' : 'No location');
}

function locate() {
  if (!navigator.geolocation) return setGPSText('GPS not available');
  const forEntry = editor.entry.id;
  navigator.geolocation.getCurrentPosition((pos) => {
    if (!editor || editor.entry.id !== forEntry || editor.entry.lat != null) return;
    Object.assign(editor.entry, { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy, alt: pos.coords.altitude });
    setGPSText();
  }, (err) => {
    if (editor && editor.entry.id === forEntry) setGPSText(err.code === 1 ? 'Location blocked — allow it in settings' : 'No GPS fix — saved without location');
  }, { enableHighAccuracy: true, timeout: 25000, maximumAge: 60000 });
}

async function addPhotos(files, input, species = null) {
  if (species) {
    // one ID photo per species per entry: replace any earlier one
    for (const m of liveMedia().filter(m => m.species === species)) removeMedia(m.id, true);
    files = [...files].slice(0, 1);
  }
  for (const f of files) {
    const exif = await U.readExif(f);
    const blob = await U.resizeImage(f);
    const taken = exif?.taken ? U.exifToDate(exif.taken) : null;
    editor.added.push({ id: U.uid(), kind: 'photo', mime: 'image/jpeg', blob, takenAt: taken ? taken.getTime() : Date.now(), originalName: f.name, ...(species ? { species } : {}) });
    // A new entry built from an older gallery photo takes that photo's time and place.
    if (species) continue; // ID photos never move the entry's time or place
    if (editor.isNew && taken && Math.abs(Date.now() - taken) > 10 * 60e3 && !editor.timeFromPhoto) {
      editor.timeFromPhoto = true; editor.entry.at = taken.getTime();
      if (editor.carriedPlace && $('#placeInput').value === editor.carriedPlace) $('#placeInput').value = '';
      $('#whenText').textContent = new Date(editor.entry.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) + ' (from photo)';
      if (exif.lat != null) { editor.entry.lat = exif.lat; editor.entry.lon = exif.lon; editor.entry.acc = null; setGPSText(); }
    } else if (editor.entry.lat == null && exif?.lat != null) {
      editor.entry.lat = exif.lat; editor.entry.lon = exif.lon; setGPSText();
    }
  }
  input.value = '';
  renderEditorMedia();
  if (species) { renderChips(); toast(`ID photo added for ${species}`); }
}

const liveMedia = () => [...editor.existing.filter(m => !editor.removed.has(m.id)), ...editor.added];

function renderEditorMedia() {
  editor.editorURLs.forEach(URL.revokeObjectURL); editor.editorURLs = [];
  const u = (b) => { const x = URL.createObjectURL(b); editor.editorURLs.push(x); return x; };
  const all = liveMedia();
  $('#photoStrip').innerHTML = all.filter(m => m.kind === 'photo' && !m.species)
    .map(m => `<div class="ph"><img src="${u(m.blob)}" alt=""><button class="rm" data-id="${m.id}" aria-label="Remove photo">✕</button></div>`).join('');
  $('#audioList').innerHTML = all.filter(m => m.kind === 'audio')
    .map(m => `<div class="aud"><audio controls src="${u(m.blob)}"></audio><button class="rm" data-id="${m.id}" aria-label="Remove recording">✕</button></div>`).join('');
  $$('#photoStrip .rm, #audioList .rm').forEach(b => b.addEventListener('click', () => removeMedia(b.dataset.id)));
}

function removeMedia(id, quiet) {
  const i = editor.added.findIndex(m => m.id === id);
  if (i >= 0) editor.added.splice(i, 1); else editor.removed.add(id);
  if (!quiet) renderEditorMedia();
}

async function toggleRecord() {
  const btn = $('#recBtn');
  if (editor.recorder) { editor.recorder.stop(); return; }
  if (!window.MediaRecorder) return toast('Voice recording is not supported in this browser');
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { return toast('Microphone blocked — allow it in your phone settings'); }
  const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported(t)) || '';
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [], started = Date.now();
  const ed = editor;
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    stream.getTracks().forEach(t => t.stop());
    clearInterval(ed.recTimer); ed.recorder = null;
    btn.classList.remove('on'); $('#recLabel').textContent = 'Record another voice note';
    if (ed.discardRecording || editor !== ed) return;
    const type = rec.mimeType || mime || 'audio/webm';
    ed.added.push({ id: U.uid(), kind: 'audio', mime: type, blob: new Blob(chunks, { type }), takenAt: started, durationSec: Math.round((Date.now() - started) / 1000) });
    renderEditorMedia();
  };
  rec.start(1000);
  editor.recorder = rec;
  btn.classList.add('on');
  const tick = () => { const s = Math.round((Date.now() - started) / 1000); $('#recLabel').textContent = `Recording ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} — tap to stop`; };
  tick(); editor.recTimer = setInterval(tick, 500);
}

function addSpecies(name) {
  name = (name || '').trim();
  if (!name) return;
  const match = SPECIES.find(s => s.toLowerCase() === name.toLowerCase());
  name = match || name.replace(/\b\w/g, c => c.toUpperCase());
  if (!editor.entry.species.includes(name)) editor.entry.species.push(name);
  $('#speciesInput').value = '';
  renderChips();
}

async function renderChips() {
  const ed = editor;
  $('#speciesChips').innerHTML = ed.entry.species.map((s, i) => {
    const p = liveMedia().find(m => m.species === s);
    const src = p ? URL.createObjectURL(p.blob) : null;
    if (src) ed.editorURLs.push(src);
    return `<span class="sp-chip"><button class="sp-cam${p ? ' has' : ''}" data-s="${U.esc(s)}" aria-label="ID photo for ${U.esc(s)}">${p ? `<img src="${src}" alt="">` : '📷'}</button>
      <span class="sp-name">${U.esc(s)}</span><button class="sp-x" data-i="${i}" aria-label="Remove ${U.esc(s)}">✕</button></span>`;
  }).join('');
  $$('#speciesChips .sp-x').forEach(b => b.addEventListener('click', () => {
    const name = ed.entry.species[+b.dataset.i];
    for (const m of liveMedia().filter(m => m.species === name)) removeMedia(m.id, true);
    ed.entry.species.splice(+b.dataset.i, 1); renderChips();
  }));
  $$('#speciesChips .sp-cam').forEach(b => b.addEventListener('click', () => { ed.photoForSpecies = b.dataset.s; $('#speciesPhotoInput').click(); }));
  $('#speciesHint').hidden = !ed.entry.species.length;
  // quick picks: your own most-used species first, then Patagonia favourites
  const counts = {};
  (await DB.all('entries')).forEach(e => (e.species || []).forEach(s => counts[s] = (counts[s] || 0) + 1));
  const mine = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  const picks = [...new Set([...mine, ...QUICK_SPECIES])].filter(s => !editor?.entry.species.includes(s)).slice(0, 8);
  if (!editor) return;
  $('#quickSpecies').innerHTML = picks.map(s => `<button class="chip" data-s="${U.esc(s)}">+ ${U.esc(s)}</button>`).join('');
  $$('#quickSpecies .chip').forEach(b => b.addEventListener('click', () => addSpecies(b.dataset.s)));
}

async function saveEditor() {
  if (editor.recorder) { toast('Stop the recording first'); return; }
  const pending = $('#speciesInput').value.trim();
  if (pending) addSpecies(pending);
  const e = editor.entry;
  e.text = $('#textInput').value.trim();
  e.place = $('#placeInput').value.trim();
  const keptMedia = editor.existing.filter(m => !editor.removed.has(m.id)).length + editor.added.length;
  if (!e.text && !keptMedia && !e.species.length) { toast('Add a note, photo, voice note or species first'); return; }
  e.updated = Date.now();
  await DB.put('entries', e);
  for (const m of editor.added) await DB.put('media', { ...m, entryId: e.id });
  for (const id of editor.removed) await DB.del('media', id);
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  const wasNew = editor.isNew;
  closeEditor();
  await renderAll();
  toast(wasNew ? 'Saved to your journal' : 'Entry updated');
}

async function deleteEntry() {
  if (!confirm('Delete this entry and its photos and recordings? This cannot be undone.')) return;
  const id = editor.entry.id;
  for (const m of await DB.mediaFor(id)) await DB.del('media', m.id);
  await DB.del('entries', id);
  closeEditor(); await renderAll(); toast('Entry deleted');
}

// ---------------- backup / merge ----------------
function wireBackup() {
  $('#exportBtn').addEventListener('click', exportBackup);
  $('#importInput').addEventListener('change', (e) => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ''; });
}

const EXT = { 'image/jpeg': 'jpg', 'audio/mp4': 'm4a', 'audio/webm': 'webm', 'audio/ogg': 'ogg' };
function mediaFileName(m, entry) {
  const tz = entry?.tz || deviceTZ();
  const d = new Date(m.takenAt || entry?.at || Date.now());
  const stamp = dayKey(d, tz) + '_' + fmtTime(d, tz).replace(/\D/g, '').padStart(4, '0');
  const tag = U.slug(m.species || (entry?.species || [])[0] || entry?.place || '');
  return `media/${stamp}${tag ? '_' + tag : ''}_${m.species ? 'id' : m.kind}_${m.id.slice(0, 8)}.${EXT[m.mime.split(';')[0]] || 'bin'}`;
}

async function exportBackup() {
  const btn = $('#exportBtn');
  btn.disabled = true; btn.textContent = 'Preparing backup…';
  try {
    const entries = (await DB.all('entries')).sort((a, b) => a.at - b.at);
    const media = await DB.all('media');
    const byId = Object.fromEntries(entries.map(e => [e.id, e]));
    const files = [], mediaIndex = [];
    for (const m of media) {
      const name = mediaFileName(m, byId[m.entryId]);
      files.push({ name, data: new Uint8Array(await m.blob.arrayBuffer()) });
      const { blob, ...meta } = m;
      mediaIndex.push({ ...meta, file: name });
    }
    const journal = {
      format: 'field-journal', version: 1, appVersion: APP_VERSION, exportedAt: new Date().toISOString(),
      device: settings.deviceName, trip: { name: settings.tripName, start: settings.tripStart },
      entries: entries.map(e => ({ ...e, localTime: new Date(e.at).toLocaleString('sv-SE', { timeZone: e.tz }), tripDay: tripDay(dayKey(e.at, e.tz)) })),
      media: mediaIndex,
    };
    const enc = new TextEncoder();
    files.unshift({ name: 'journal.json', data: enc.encode(JSON.stringify(journal, null, 2)) });
    files.splice(1, 0, { name: 'journal.md', data: enc.encode(toMarkdown(journal)) });
    const zip = U.makeZip(files);
    const fname = `field-journal_${U.slug(settings.deviceName)}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.zip`;
    const file = new File([zip], fname, { type: 'application/zip' });

    let shared = false;
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Field Journal backup' }); shared = true; }
      catch (e) { if (e.name === 'AbortError') { toast('Backup cancelled'); return; } }
    }
    if (!shared) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file); a.download = fname;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    }
    settings.lastBackup = Date.now(); await DB.setSetting('lastBackup', settings.lastBackup);
    renderBackupInfo(entries.length);
    toast(`Backup ready · ${(zip.size / 1048576).toFixed(1)} MB`);
  } catch (e) {
    toast('Backup failed: ' + e.message, 5000);
  } finally {
    btn.disabled = false; btn.textContent = 'Save backup';
  }
}

function toMarkdown(j) {
  let out = `# ${j.trip.name || 'Trip'} — Field Journal\n\nExported ${j.exportedAt} from ${j.device}\n`;
  let lastDay = '';
  for (const e of j.entries) {
    const day = e.localTime.slice(0, 10);
    if (day !== lastDay) { out += `\n## ${e.tripDay ? 'Day ' + e.tripDay + ' — ' : ''}${day}\n`; lastDay = day; }
    out += `\n### ${e.localTime.slice(11, 16)}${e.place ? ' · ' + e.place : ''}\n`;
    if (e.lat != null) out += `Location: ${e.lat.toFixed(5)}, ${e.lon.toFixed(5)}\n`;
    if (e.species?.length) out += `Species: ${e.species.join(', ')}\n`;
    if (e.text) out += `\n${e.text}\n`;
    const files = j.media.filter(m => m.entryId === e.id).map(m => m.file);
    if (files.length) out += `\nMedia: ${files.join(', ')}\n`;
  }
  return out;
}

async function importBackup(file) {
  try {
    toast('Reading backup…', 8000);
    const files = await U.readZip(file);
    if (!files['journal.json']) throw new Error('This is not a Field Journal backup');
    const j = JSON.parse(new TextDecoder().decode(files['journal.json']));
    const existing = Object.fromEntries((await DB.all('entries')).map(e => [e.id, e]));
    const existingMedia = new Set(await DB.keys('media'));
    let added = 0, updated = 0, mediaAdded = 0;
    for (const e of j.entries) {
      const { localTime, tripDay: _td, ...clean } = e;
      const cur = existing[e.id];
      if (!cur) { await DB.put('entries', clean); added++; }
      else if ((e.updated || 0) > (cur.updated || 0)) { await DB.put('entries', clean); updated++; }
    }
    for (const m of j.media) {
      if (existingMedia.has(m.id) || !files[m.file]) continue;
      const { file: f, ...meta } = m;
      await DB.put('media', { ...meta, blob: new Blob([files[m.file]], { type: m.mime }) });
      mediaAdded++;
    }
    await renderAll();
    toast(`Merged from ${j.device || 'backup'}: ${added} new, ${updated} updated, ${mediaAdded} photos/recordings`, 5000);
  } catch (e) {
    toast('Could not open backup: ' + e.message, 6000);
  }
}

boot();
