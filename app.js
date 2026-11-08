// Field Journal — offline travel diary. Phase 1: capture. Phase 2 (later): book builder.
const APP_VERSION = '1.5.3';
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
function trackURL(blob) { if (!blob) return ''; const u = URL.createObjectURL(blob); urls.push(u); return u; }
const src = (m) => m.blob || m.thumb;                      // full photo, or preview if freed to the cloud
const liveEntries = async () => (await DB.all('entries')).filter(e => !e.deleted);
const liveMediaAll = async () => (await DB.all('media')).filter(m => !m.deleted);
async function tombstoneMedia(id) {
  const m = await DB.get('media', id);
  if (!m) return;
  // keep only what's needed to remove the cloud copy; no photo, names or details stay behind
  await DB.put('media', { id: m.id, entryId: m.entryId, kind: m.kind, mime: m.mime, uploaded: m.uploaded, deleted: true, updated: Date.now(), dirty: true });
}

// ---------------- boot ----------------
async function boot() {
  settings.deviceName = await DB.setting('deviceName', /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android' : 'Phone');
  settings.tripStart = await DB.setting('tripStart', '2026-11-30');
  settings.tripName = await DB.setting('tripName', 'Patagonia');
  settings.tripLength = await DB.setting('tripLength', 12);
  settings.lastBackup = await DB.setting('lastBackup', null);

  $('#deviceName').value = settings.deviceName;
  $('#tripStart').value = settings.tripStart;
  $('#tripName').value = settings.tripName;
  $('#tripLength').value = settings.tripLength;
  for (const [id, key] of [['#deviceName', 'deviceName'], ['#tripStart', 'tripStart'], ['#tripName', 'tripName'], ['#tripLength', 'tripLength']]) {
    $(id).addEventListener('change', async (e) => {
      settings[key] = key === 'tripLength' ? Math.max(1, Math.min(90, parseInt(e.target.value, 10) || 12)) : e.target.value.trim();
      await DB.setSetting(key, settings[key]); renderAll();
    });
  }
  wireDayNav();

  $('#speciesSuggest').innerHTML = SPECIES.map(s => `<option value="${U.esc(s)}">`).join('');
  $$('.tab').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
  $$('.cap').forEach(b => b.addEventListener('click', () => openEditor(null, b.dataset.mode)));
  wireEditor();
  wireViewer();
  wireBackup();
  addEventListener('online', updateNet); addEventListener('offline', updateNet);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', checkOffline);
  }
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  setTimeout(checkOffline, 1500); setTimeout(checkOffline, 8000);
  wireCloud();
  wireInstall();
  await renderAll();
  Sync.init(() => renderAll());
}

function updateNet() { renderSyncState(Sync.state); }
function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago';
}
function renderSyncState(st) {
  const b = $('#netBadge');
  let text, warn = false;
  if (!st.configured || !st.signedIn) { text = navigator.onLine ? '● online' : '● offline — saved on phone'; warn = !navigator.onLine; }
  else if (!navigator.onLine || st.status === 'offline') { text = `● offline${st.pending ? ' · ' + st.pending + ' to sync' : ' — saved on phone'}`; warn = true; }
  else if (['syncing', 'uploading', 'downloading'].includes(st.status)) text = st.status === 'uploading' ? `● uploading${st.pending ? ' ' + st.pending : ''}…` : st.status === 'downloading' ? '● downloading…' : '● syncing…';
  else if (st.status === 'error') { text = '● sync paused'; warn = true; }
  else text = st.pending ? `● ${st.pending} to sync` : `● synced${st.lastSync ? ' ' + ago(st.lastSync) : ''}`;
  b.textContent = text; b.classList.toggle('off', warn);
  const c = $('#cloudStatus');
  if (c) {
    $('#cloudSignedOut').hidden = !st.configured || st.signedIn;
    $('#cloudSignedIn').hidden = !st.signedIn;
    $('#cloudNotSetUp').hidden = st.configured;
    if (st.signedIn) c.textContent = `Signed in as ${st.email}. ` + (st.status === 'error' ? 'Sync paused: ' + st.error
      : st.pending ? `${st.pending} change${st.pending > 1 ? 's' : ''} waiting for signal.` : st.lastSync ? `Everything synced ${ago(st.lastSync)}.` : 'Not synced yet.');
  }
}

function showView(v) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === v));
  $$('.view').forEach(s => s.classList.toggle('active', s.id === 'view-' + v));
  $('#captureBar').style.display = ['settings', 'calendar', 'map'].includes(v) ? 'none' : '';
  if (v === 'map') showMap();
  if (v === 'settings') renderStorage();
}

// ---------------- rendering ----------------
async function renderAll() {
  urls.forEach(URL.revokeObjectURL); urls = [];
  const entries = (await liveEntries()).sort((a, b) => b.at - a.at);
  const media = await liveMediaAll();
  const byEntry = {};
  for (const m of media) (byEntry[m.entryId] ||= []).push(m);

  // header
  const todayKey = dayKey(Date.now(), deviceTZ());
  const td = tripDay(todayKey);
  $('#tripLine').textContent = `${settings.tripName || 'Trip'} · Field Journal`;
  $('#dayTitle').textContent = td ? `Day ${td}` : (settings.tripStart > todayKey ? `${Math.ceil((new Date(settings.tripStart) - new Date(todayKey)) / 864e5)} days to go` : 'Field Journal');

  lastData = { entries, byEntry };
  renderDayStrip(entries);
  renderTimeline(entries, byEntry);
  renderCalendar(entries, byEntry);
  if ($('#view-map').classList.contains('active')) renderMap(); else mapStale = true;
  renderSpecies(entries, media);
  renderBackupInfo(entries.length);
  renderSyncState(Sync.state);
}

// ---------------- days: Journal shows one day at a time (today by default) ----------------
let selectedDay = null;       // 'YYYY-MM-DD'
let followToday = true;       // keep showing "today" until Bobby picks another day
let lastData = { entries: [], byEntry: {} };
const todayKey = () => dayKey(Date.now(), deviceTZ());
const addDays = (key, n) => { const d = new Date(key + 'T12:00:00'); d.setDate(d.getDate() + n); return dayKey(d.getTime(), deviceTZ()); };
const tripEnd = () => settings.tripStart ? addDays(settings.tripStart, (settings.tripLength || 12) - 1) : null;
const entryDay = (e) => dayKey(e.at, e.tz);
function dayLabel(k) { const td = tripDay(k); return td && k <= tripEnd() ? `Day ${td}` : null; }

function groupByDay(entries) {
  const g = new Map();
  for (const e of entries) { const k = entryDay(e); if (!g.has(k)) g.set(k, []); g.get(k).push(e); }
  return g;
}

// Days shown in the strip: every trip day, every day with entries, and today.
function stripDays(entries) {
  const set = new Set(entries.map(entryDay));
  set.add(todayKey());
  if (settings.tripStart) for (let i = 0; i < (settings.tripLength || 12); i++) set.add(addDays(settings.tripStart, i));
  return [...set].sort();
}

function selectDay(k, { fromUser = true } = {}) {
  selectedDay = k;
  if (fromUser) followToday = k === todayKey();
  renderDayStrip(lastData.entries);
  renderTimeline(lastData.entries, lastData.byEntry);
  window.scrollTo({ top: 0 });
}

function wireDayNav() {
  // swipe left/right on the journal to move between days
  let x0 = null, y0 = 0;
  const el = $('#view-timeline');
  el.addEventListener('touchstart', (e) => { if (e.target.closest('.day-strip, audio')) return; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0; x0 = null;
    if (Math.abs(dx) < 70 || Math.abs(dy) > 50) return;
    const days = stripDays(lastData.entries), i = days.indexOf(selectedDay);
    const next = days[i + (dx < 0 ? 1 : -1)];
    if (next) selectDay(next);
  }, { passive: true });
  // a new day while the app sits open: move to it if Bobby was following today
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && followToday && selectedDay !== todayKey()) selectDay(todayKey(), { fromUser: false });
  });
}

function renderDayStrip(entries) {
  if (!selectedDay) selectedDay = todayKey();
  const groups = groupByDay(entries), today = todayKey();
  const days = stripDays(entries);
  const el = $('#dayStrip');
  el.innerHTML = days.map(k => {
    const n = (groups.get(k) || []).length, lbl = dayLabel(k);
    const d = new Date(k + 'T12:00:00');
    return `<button class="dchip${k === selectedDay ? ' sel' : ''}${k > today ? ' future' : ''}${k === today ? ' today' : ''}" data-k="${k}">
      <span>${lbl || d.toLocaleDateString([], { month: 'short' })}</span><b>${d.getDate()}</b><span class="cnt">${n || '–'}</span></button>`;
  }).join('');
  el.querySelectorAll('.dchip').forEach(b => b.addEventListener('click', () => selectDay(b.dataset.k)));
  const sel = el.querySelector('.sel');
  if (sel) el.scrollLeft = sel.offsetLeft - el.clientWidth / 2 + sel.offsetWidth / 2;
}

function renderTimeline(entries, byEntry) {
  const el = $('#timeline');
  const k = selectedDay || todayKey();
  const list = entries.filter(e => entryDay(e) === k).sort((a, b) => a.at - b.at);   // morning → evening
  const lbl = dayLabel(k), isToday = k === todayKey();
  const media = list.flatMap(e => byEntry[e.id] || []);
  const species = new Set(list.flatMap(e => e.species || []));
  const places = [...new Set(list.map(e => e.place).filter(Boolean))];
  const route = places.length > 3 ? [places[0], '…', places[places.length - 1]] : places;
  let html = `<div class="daycard">
    <h2>${lbl ? lbl + ' · ' : ''}${U.esc(fmtDay(k))}${isToday ? ' <span class="todaytag">today</span>' : ''}</h2>
    ${route.length ? `<div class="sub">${route.map(U.esc).join(' → ')}</div>` : ''}
    <div class="stats"><div><b>${list.length}</b>entr${list.length === 1 ? 'y' : 'ies'}</div><div><b>${species.size}</b>species</div>
      <div><b>${media.filter(m => m.kind === 'photo').length}</b>photos</div><div><b>${media.filter(m => m.kind === 'audio').length}</b>voice</div></div>
  </div>`;
  if (!list.length) {
    html += entries.length || !isToday
      ? `<div class="empty small-empty"><p>${isToday ? 'Nothing logged today yet.' : k > todayKey() ? 'This day is still ahead.' : 'No entries on this day.'}</p>${isToday ? '<p>Tap <b>Voice</b>, <b>Photo</b> or <b>Note</b> below.</p>' : ''}</div>`
      : `<div class="empty"><h2>Your journal starts here</h2><p>Tap <b>Voice</b>, <b>Photo</b> or <b>Note</b> below. Every entry gets the time and your GPS position automatically — no signal needed.</p></div>`;
  }
  for (const e of list) {
    const m = byEntry[e.id] || [];
    const photos = m.filter(x => x.kind === 'photo' && !x.species);
    const idPhoto = (s) => m.find(x => x.kind === 'photo' && x.species === s);
    const audio = m.filter(x => x.kind === 'audio');
    html += `<article class="entry" data-id="${e.id}">
      <div class="when"><span>${fmtTime(e.at, e.tz)}</span>${e.place ? `<span class="place">${U.esc(e.place)}</span>` : ''}${e.lat != null ? `<span>📍${e.lat.toFixed(3)}, ${e.lon.toFixed(3)}</span>` : ''}${e.device ? `<span>· ${U.esc(e.device)}</span>` : ''}</div>
      ${e.text ? `<p class="text">${U.esc(e.text)}</p>` : ''}
      ${photos.length ? `<div class="thumbs">${photos.map(p => `<img src="${trackURL(src(p))}" alt="" loading="lazy">`).join('')}</div>` : ''}
      ${audio.map(a => a.blob ? `<audio controls preload="none" src="${trackURL(a.blob)}"></audio>` : '<p class="muted small">🎙 voice note downloading…</p>').join('')}
      ${(e.species || []).length ? `<div class="chips tags">${e.species.map(s => { const p = idPhoto(s); return `<span class="chip${p ? ' has-av' : ''}">${p ? `<img class="av" src="${trackURL(src(p))}" alt="">` : ''}${U.esc(s)}</span>`; }).join('')}</div>` : ''}
    </article>`;
  }
  el.innerHTML = html;
  el.querySelectorAll('.entry').forEach(a => a.addEventListener('click', (ev) => {
    if (ev.target.closest('audio')) return;
    openView(a.dataset.id);
  }));
}

// ---------------- map: route = entries joined in time order, one colour per day ----------------
const DAY_COLOURS = ['#2f6f73', '#c2793a', '#7b5ea7', '#3f8f4e', '#b4423a', '#2a6cb0', '#a0782b', '#c0508c', '#4f7d8a', '#6b8e23', '#8c5a3c', '#3c5a99'];
let map = null, mapLayer = null, mapBase = {}, mapDay = 'all', mapStale = true;

function haversineKm(a, b) {
  const R = 6371, rad = (x) => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function ensureMap() {
  if (map || !window.L) return !!map;
  map = L.map('map', { zoomControl: true, attributionControl: true, worldCopyJump: true }).setView([-50.9, -72.9], 7);
  mapBase.map = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' });
  mapBase.terrain = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, subdomains: 'abc', attribution: '© OpenStreetMap contributors, SRTM · style © OpenTopoMap (CC-BY-SA)' });
  mapBase.map.addTo(map);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
  mapLayer = L.layerGroup().addTo(map);
  $$('.seg button').forEach(b => b.addEventListener('click', () => {
    $$('.seg button').forEach(x => x.classList.toggle('on', x === b));
    Object.values(mapBase).forEach(l => map.removeLayer(l));
    mapBase[b.dataset.layer].addTo(map);
  }));
  $('#mapDay').addEventListener('change', (e) => { mapDay = e.target.value; renderMap(true); });
  map.on('popupopen', (ev) => {
    const btn = ev.popup.getElement()?.querySelector('[data-open-day]');
    if (btn) btn.addEventListener('click', () => { map.closePopup(); selectDay(btn.dataset.openDay); showView('timeline'); });
  });
  return true;
}

function showMap() {
  if (!ensureMap()) { $('#mapStats').textContent = 'Map could not load.'; return; }
  setTimeout(() => { map.invalidateSize(); if (mapStale) renderMap(true); }, 60);
}

function renderMap(fit = false) {
  if (!map) return;
  mapStale = false;
  const { entries, byEntry } = lastData;
  const located = entries.filter(e => e.lat != null && e.lon != null).sort((a, b) => a.at - b.at);
  const groups = groupByDay(located);
  const days = [...groups.keys()].sort();
  if (mapDay !== 'all' && !groups.has(mapDay)) mapDay = 'all';
  $('#mapDay').innerHTML = `<option value="all">Whole trip${days.length ? ` · ${days.length} day${days.length > 1 ? 's' : ''}` : ''}</option>` +
    days.map(k => `<option value="${k}"${k === mapDay ? ' selected' : ''}>${U.esc(dayLabel(k) ? dayLabel(k) + ' · ' : '')}${U.esc(new Date(k + 'T12:00:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }))}</option>`).join('');
  $('#mapDay').value = mapDay;
  mapLayer.clearLayers();
  $('#mapEmpty').hidden = located.length > 0;
  const shownDays = mapDay === 'all' ? days : [mapDay];
  const whole = mapDay === 'all';
  const bounds = [];
  let km = 0, stops = 0;
  // whole trip: faint dashed link from each day's last stop to the next day's first stop
  if (whole) for (let i = 1; i < days.length; i++) {
    const a = groups.get(days[i - 1]).slice(-1)[0], b = groups.get(days[i])[0];
    L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { color: '#69716d', weight: 2, opacity: .6, dashArray: '4 6' }).addTo(mapLayer);
  }
  shownDays.forEach((k) => {
    const list = groups.get(k);
    const colour = DAY_COLOURS[days.indexOf(k) % DAY_COLOURS.length];
    const pts = list.map(e => [e.lat, e.lon]);
    for (let i = 1; i < list.length; i++) km += haversineKm(list[i - 1], list[i]);
    stops += list.length;
    if (pts.length > 1) L.polyline(pts, { color: colour, weight: 4, opacity: .85, lineJoin: 'round' }).addTo(mapLayer);
    list.forEach((e, i) => {
      bounds.push([e.lat, e.lon]);
      const photo = (byEntry[e.id] || []).find(m => m.kind === 'photo' && src(m));
      const icon = whole
        ? L.divIcon({ className: 'pin', html: `<span class="dot" style="background:${colour}"></span>`, iconSize: [16, 16], iconAnchor: [8, 8] })
        : L.divIcon({ className: 'pin', html: `<span style="background:${colour}">${i + 1}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] });
      const html = `<div class="pop"><div class="pop-when">${U.esc(dayLabel(k) || fmtDay(k))} · ${fmtTime(e.at, e.tz)}</div>
        ${e.place ? `<div class="pop-place">${U.esc(e.place)}</div>` : ''}
        ${photo ? `<img src="${trackURL(src(photo))}" alt="">` : ''}
        ${e.text ? `<div class="pop-text">${U.esc(e.text.length > 90 ? e.text.slice(0, 90) + '…' : e.text)}</div>` : ''}
        ${(e.species || []).length ? `<div class="pop-sp">${e.species.map(U.esc).join(' · ')}</div>` : ''}
        <button class="btn small" data-open-day="${k}">Open this day</button></div>`;
      L.marker([e.lat, e.lon], { icon }).bindPopup(html, { maxWidth: 240 }).addTo(mapLayer);
    });
  });
  // colour key: tap a day to zoom into it
  $('#mapKey').innerHTML = whole && days.length > 1 ? days.map((k, i) => `<button class="key" data-k="${k}"><i style="background:${DAY_COLOURS[i % DAY_COLOURS.length]}"></i>${U.esc((dayLabel(k) || new Date(k + 'T12:00:00').toLocaleDateString([], { day: 'numeric', month: 'short' })).replace('Day ', 'D'))}</button>`).join('') : '';
  $$('#mapKey .key').forEach(b => b.addEventListener('click', () => { mapDay = b.dataset.k; renderMap(true); }));
  const what = mapDay === 'all' ? 'Whole trip' : (dayLabel(mapDay) || fmtDay(mapDay));
  $('#mapStats').textContent = located.length
    ? `${what} · ${stops} stop${stops === 1 ? '' : 's'} · ${km < 10 ? km.toFixed(1) : Math.round(km)} km between entries${navigator.onLine ? '' : ' · offline'}`
    : '';
  if (fit && bounds.length) map.fitBounds(bounds, { padding: [36, 36], maxZoom: 14 });
}

// ---------------- calendar ----------------
function renderCalendar(entries, byEntry) {
  const groups = groupByDay(entries), today = todayKey();
  const keys = [...groups.keys(), today, settings.tripStart, tripEnd()].filter(Boolean).sort();
  // whole weeks (Mon–Sun) from the first relevant day to the last
  const monday = (k) => { const d = new Date(k + 'T12:00:00'); return addDays(k, -((d.getDay() + 6) % 7)); };
  let start = monday(keys[0]);
  const end = addDays(monday(keys[keys.length - 1]), 6);
  const max = Math.max(0, ...[...groups.values()].map(l => l.length));
  const first = new Date(start + 'T12:00:00'), last = new Date(end + 'T12:00:00');
  const title = first.getMonth() === last.getMonth() ? first.toLocaleDateString([], { month: 'long', year: 'numeric' })
    : `${first.toLocaleDateString([], { month: 'short' })} – ${last.toLocaleDateString([], { month: 'short', year: 'numeric' })}`;
  let cells = '', prevShown = null;
  for (let k = start; k <= end; k = addDays(k, 1)) {
    const n = (groups.get(k) || []).length, d = new Date(k + 'T12:00:00');
    const inTrip = settings.tripStart && k >= settings.tripStart && k <= tripEnd();
    if (d.getDay() === 1) {
      // only show weeks that matter: trip days, days with entries, today — collapse the rest
      let keep = false;
      for (let i = 0; i < 7; i++) { const kk = addDays(k, i); if (groups.has(kk) || kk === today || (settings.tripStart && kk >= settings.tripStart && kk <= tripEnd())) keep = true; }
      if (!keep) { k = addDays(k, 6); continue; }
      if (prevShown && prevShown !== addDays(k, -7)) cells += '<div class="gap">⋯</div>';
      prevShown = k;
    }
    const lvl = !n ? '' : n === max && max > 1 ? ' hi' : n < max / 2 ? ' lo' : '';
    cells += `<button class="cell${inTrip ? ' trip' : ''}${k === today ? ' today' : ''}${k === selectedDay ? ' sel' : ''}" data-k="${k}" aria-label="${U.esc(fmtDay(k))}, ${n} entries">
      ${d.getDate() === 1 ? `<span class="mon">${d.toLocaleDateString([], { month: 'short' })}</span>` : ''}${d.getDate()}
      ${inTrip ? `<span class="tday">D${tripDay(k)}</span>` : ''}${n ? `<span class="n${lvl}">${n}</span>` : ''}</button>`;
  }
  // trip totals
  const tripEntries = settings.tripStart ? entries.filter(e => { const k = entryDay(e); return k >= settings.tripStart && k <= tripEnd(); }) : [];
  const pool = tripEntries.length ? tripEntries : entries;
  const species = new Set(pool.flatMap(e => e.species || []));
  const photos = pool.flatMap(e => byEntry[e.id] || []).filter(m => m.kind === 'photo').length;
  let best = null;
  for (const [k, l] of groups) if (!best || l.length > best[1].length) best = [k, l];
  let bestText = '';
  if (best) {
    const sp = [...new Set(best[1].flatMap(e => e.species || []))].slice(0, 2);
    bestText = `${dayLabel(best[0]) || fmtDay(best[0])} — ${best[1].length} entr${best[1].length === 1 ? 'y' : 'ies'}${sp.length ? ', ' + sp.join(' + ') : ''}`;
  }
  $('#calendar').innerHTML = `<div class="cal">
      <h3>${U.esc(title)} <span>${settings.tripStart ? (settings.tripLength || 12) + '-day trip' : ''}</span></h3>
      <div class="grid">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(d => `<div class="dow">${d}</div>`).join('')}${cells}</div>
      <div class="legend"><span><i class="lg-trip"></i>trip day</span><span><i class="lg-hi"></i>busiest</span><span><i class="lg-today"></i>today</span></div>
    </div>
    <div class="peek"><h4>Tap a day to open it in Journal</h4>
      <div class="row2">${tripEntries.length ? 'Trip so far' : 'So far'}: <b>${pool.length} entr${pool.length === 1 ? 'y' : 'ies'}</b> · <b>${species.size} species</b> · <b>${photos} photos</b></div>
      ${bestText ? `<div class="row2">Best day: <b>${U.esc(bestText)}</b></div>` : ''}
    </div>`;
  $$('#calendar .cell').forEach(c => c.addEventListener('click', () => { selectDay(c.dataset.k); showView('timeline'); }));
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
        ${ph.length ? `<img class="sp-thumb" src="${trackURL(src(ph[0]))}" alt="">` : '<span class="sp-thumb none">🐾</span>'}
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
    <div class="viewer-grid">${list.map(m => `<figure><img data-id="${m.id}" src="${trackURL(src(m))}" alt=""><figcaption>${new Date(m.takenAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</figcaption></figure>`).join('')}</div>`;
  v.hidden = false; document.documentElement.classList.add('sheet-open');
  // swap previews for full photos from the cloud where the phone copy was freed
  list.filter(m => !m.blob).forEach(async (m) => {
    const full = await Sync.fullBlob(m);
    const img = v.querySelector(`img[data-id="${m.id}"]`);
    if (full && img && full !== m.thumb) img.src = trackURL(full);
  });
  $('#viewerClose').addEventListener('click', () => { v.hidden = true; v.innerHTML = ''; document.documentElement.classList.remove('sheet-open'); });
}

function renderBackupInfo(count) {
  const lb = settings.lastBackup;
  $('#lastBackup').textContent = `${count} entr${count === 1 ? 'y' : 'ies'} on this phone · ` +
    (lb ? 'last backup ' + new Date(lb).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'no backup yet');
}

// Is this phone ready to open the app with no signal?
let offlineReady = null;
async function checkOffline() {
  let ready = false;
  try {
    const controlled = !!navigator.serviceWorker?.controller;
    const page = await caches.match('index.html', { ignoreSearch: true, ignoreVary: true });
    const leaflet = await caches.match('vendor/leaflet/leaflet.js', { ignoreSearch: true, ignoreVary: true });
    ready = controlled && !!page && !!leaflet;
  } catch (e) { ready = false; }
  offlineReady = ready;
  const el = $('#offlineReady');
  if (el) {
    el.className = 'offline-ready ' + (ready ? 'ok' : 'no');
    el.textContent = ready ? '✓ Ready to use offline' : '✗ Not ready for offline yet — open the app with signal, wait 10 seconds, then close and reopen it';
  }
  return ready;
}

async function renderStorage() {
  checkOffline();
  if (!navigator.storage?.estimate) return;
  const { usage, quota } = await navigator.storage.estimate();
  const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
  $('#storageInfo').textContent = `Using ${(usage / 1048576).toFixed(1)} MB of ~${(quota / 1073741824).toFixed(1)} GB available · ${persisted ? 'protected from auto-cleanup' : 'not yet protected from auto-cleanup'} · v${APP_VERSION}`;
}

// ---------------- entry view (read-only) ----------------
let viewing = null;   // { id, urls: [] }

async function openView(id) {
  const e = await DB.get('entries', id);
  if (!e || e.deleted) return;
  const media = (await DB.mediaFor(id)).filter(m => !m.deleted);
  closeView();
  viewing = { id, urls: [] };
  const u = (b) => { if (!b) return ''; const x = URL.createObjectURL(b); viewing.urls.push(x); return x; };
  const k = entryDay(e), lbl = dayLabel(k);
  const photos = media.filter(m => m.kind === 'photo' && !m.species).sort((a, b) => a.takenAt - b.takenAt);
  const audio = media.filter(m => m.kind === 'audio').sort((a, b) => a.takenAt - b.takenAt);
  const idPhoto = (s) => media.find(m => m.kind === 'photo' && m.species === s);
  const dur = (s) => s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '';
  const gallery = [...photos, ...(e.species || []).map(idPhoto).filter(Boolean)];
  viewing.gallery = gallery.map(m => ({ m, cap: m.species ? `${m.species} · ID photo` : `${fmtTime(m.takenAt || e.at, e.tz)}${e.place ? ' · ' + e.place : ''}` }));

  $('#viewTitle').textContent = lbl ? `${lbl} · ${fmtTime(e.at, e.tz)}` : fmtTime(e.at, e.tz);
  $('#viewBody').innerHTML = `
    ${photos.length ? `<div class="v-photos${photos.length === 1 ? ' one' : ''}">${photos.map((p, i) =>
      `<button class="v-ph" data-g="${i}" aria-label="Open photo ${i + 1}"><img src="${u(src(p))}" alt=""></button>`).join('')}</div>
      ${photos.length > 1 ? `<p class="v-hint">${photos.length} photos · swipe · tap to enlarge</p>` : '<p class="v-hint">Tap photo to enlarge</p>'}` : ''}
    <div class="v-meta">
      <div class="v-when">${U.esc(fmtDay(k))} · ${fmtTime(e.at, e.tz)}</div>
      ${e.place ? `<div class="v-place">${U.esc(e.place)}</div>` : ''}
      ${e.lat != null ? `<div class="v-gps">📍 ${e.lat.toFixed(4)}, ${e.lon.toFixed(4)}${e.acc ? ` ±${Math.round(e.acc)} m` : ''}</div>` : ''}
    </div>
    ${e.text ? `<p class="v-text">${U.esc(e.text)}</p>` : ''}
    ${audio.map((a, i) => a.blob
      ? `<div class="v-audio"><div class="v-audio-l">🎙 Voice note${audio.length > 1 ? ' ' + (i + 1) : ''}${a.durationSec ? ' · ' + dur(a.durationSec) : ''}</div><audio controls preload="metadata" src="${u(a.blob)}"></audio></div>`
      : `<div class="v-audio"><div class="v-audio-l">🎙 Voice note downloading…</div></div>`).join('')}
    ${(e.species || []).length ? `<h3 class="v-h">Species</h3><div class="v-species">${e.species.map(s => {
      const p = idPhoto(s), gi = p ? gallery.indexOf(p) : -1;
      return `<button class="v-sp"${gi >= 0 ? ` data-g="${gi}"` : ''}>${p ? `<img src="${u(src(p))}" alt="">` : '<span class="v-sp-none">🐾</span>'}<span>${U.esc(s)}</span></button>`;
    }).join('')}</div>` : ''}
    ${!e.text && !media.length && !(e.species || []).length ? '<p class="muted">This entry is empty.</p>' : ''}
    <p class="v-foot">${e.device ? 'Logged on ' + U.esc(e.device) : ''}${e.updated && e.updated - (e.created || e.at) > 60000 ? ' · edited ' + new Date(e.updated).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : ''}</p>
    <button class="btn wide" id="viewEdit2">✎ Edit entry</button>`;
  $$('#viewBody [data-g]').forEach(b => b.addEventListener('click', () => openLightbox(+b.dataset.g)));
  $('#viewEdit2').addEventListener('click', editFromView);
  $('#viewSheet').hidden = false;
  $('#viewSheet .sheet-body').scrollTop = 0;
  document.documentElement.classList.add('sheet-open');
}

function closeView() {
  if (!viewing) return;
  $$('#viewBody audio').forEach(a => a.pause());
  closeLightbox();
  viewing.urls.forEach(URL.revokeObjectURL);
  viewing = null;
  $('#viewSheet').hidden = true; $('#viewBody').innerHTML = '';
  document.documentElement.classList.remove('sheet-open');
}

function editFromView() {
  const id = viewing?.id;
  closeView();
  if (id) openEditor(id);
}

// ---------------- full-screen photo ----------------
let lb = null;   // { i, url }
async function openLightbox(i) {
  if (!viewing?.gallery?.length) return;
  lb = { i: Math.max(0, Math.min(i, viewing.gallery.length - 1)), url: null };
  $('#lightbox').hidden = false;
  showLightbox();
}
async function showLightbox() {
  const item = viewing.gallery[lb.i];
  const img = $('#lbImg');
  img.classList.remove('zoom'); $('#lbStage').scrollTo(0, 0);
  if (lb.url) URL.revokeObjectURL(lb.url);
  lb.url = URL.createObjectURL(src(item.m)); img.src = lb.url;
  $('#lbCap').textContent = item.cap;
  $('#lbCount').textContent = viewing.gallery.length > 1 ? `${lb.i + 1} / ${viewing.gallery.length}` : '';
  $('#lbPrev').hidden = lb.i === 0; $('#lbNext').hidden = lb.i === viewing.gallery.length - 1;
  if (!item.m.blob) {                       // freed to the cloud: fetch the full photo
    const want = lb.i, full = await Sync.fullBlob(item.m);
    if (lb && lb.i === want && full && full !== item.m.thumb) { URL.revokeObjectURL(lb.url); lb.url = URL.createObjectURL(full); img.src = lb.url; }
  }
}
function closeLightbox() {
  if (!lb) return;
  if (lb.url) URL.revokeObjectURL(lb.url);
  lb = null; $('#lightbox').hidden = true; $('#lbImg').removeAttribute('src');
}
function wireViewer() {
  $('#viewClose').addEventListener('click', closeView);
  $('#viewEdit').addEventListener('click', editFromView);
  $('#lbClose').addEventListener('click', closeLightbox);
  const step = (d) => { if (!lb) return; const n = lb.i + d; if (n >= 0 && n < viewing.gallery.length) { lb.i = n; showLightbox(); } };
  $('#lbPrev').addEventListener('click', () => step(-1));
  $('#lbNext').addEventListener('click', () => step(1));
  $('#lbImg').addEventListener('click', () => $('#lbImg').classList.toggle('zoom'));   // tap to zoom in/out
  let x0 = null;
  $('#lbStage').addEventListener('touchstart', (e) => { x0 = $('#lbImg').classList.contains('zoom') ? null : e.touches[0].clientX; }, { passive: true });
  $('#lbStage').addEventListener('touchend', (e) => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0; x0 = null; if (Math.abs(dx) > 60) step(dx < 0 ? 1 : -1); }, { passive: true });
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
  for (const id of ['#speciesPhotoInput', '#speciesCameraInput'])
    $(id).addEventListener('change', (e) => { if (editor?.photoForSpecies) addPhotos(e.target.files, e.target, editor.photoForSpecies); });
  // iPhone's picker already offers camera + library; Android's newer picker hides the camera, so offer both.
  const closeChooser = () => { $('#chooser').hidden = true; };
  $('#chooseCamera').addEventListener('click', () => { closeChooser(); $('#speciesCameraInput').click(); });
  $('#chooseGallery').addEventListener('click', () => { closeChooser(); $('#speciesPhotoInput').click(); });
  $('#chooseCancel').addEventListener('click', closeChooser);
  $('#chooser').addEventListener('click', (e) => { if (e.target.id === 'chooser') closeChooser(); });
  $('#recBtn').addEventListener('click', toggleRecord);
  // tap the date/time to change it
  $('#whenBtn').addEventListener('click', () => {
    const inp = $('#whenInput');
    inp.value = toLocalInput(editor.entry.at);
    inp.hidden = false; inp.focus();
    try { inp.showPicker?.(); } catch (e) { /* some browsers need a direct tap */ }
  });
  $('#whenInput').addEventListener('change', (e) => {
    if (!e.target.value || !editor) return;
    const t = new Date(e.target.value).getTime();
    if (isNaN(t)) return;
    editor.entry.at = t; editor.entry.tz = deviceTZ(); editor.timeFromPhoto = false;
    updateWhen();
  });
  $('#addSpeciesBtn').addEventListener('click', () => addSpecies($('#speciesInput').value));
  $('#speciesInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addSpecies(e.target.value); } });
}

async function openEditor(id, mode) {
  const isNew = !id;
  const entry = isNew
    ? { id: U.uid(), at: Date.now(), tz: deviceTZ(), offsetMin: -new Date().getTimezoneOffset(), device: settings.deviceName, text: '', species: [], place: '', lat: null, lon: null, created: Date.now() }
    : await DB.get('entries', id);
  const existing = isNew ? [] : (await DB.mediaFor(id)).filter(m => !m.deleted);
  editor = { entry: { ...entry, species: [...(entry.species || [])] }, isNew, existing, added: [], removed: new Set(), editorURLs: [], recorder: null };

  if (isNew) {
    const last = (await liveEntries()).sort((a, b) => b.at - a.at)[0];
    if (last && Date.now() - last.at < 3 * 3600e3) editor.entry.place = editor.carriedPlace = last.place || ''; // carry place forward
  }

  $('#sheetTitle').textContent = isNew ? 'New entry' : 'Edit entry';
  $('#textInput').value = editor.entry.text || '';
  $('#placeInput').value = editor.entry.place || '';
  $('#speciesInput').value = '';
  $('#deleteBtn').hidden = isNew;
  $('#whenInput').hidden = true;
  updateWhen();
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

function updateWhen() {
  const e = editor.entry;
  $('#whenText').textContent = new Date(e.at).toLocaleString([], { timeZone: e.tz, dateStyle: 'medium', timeStyle: 'short' }) + (editor.timeFromPhoto ? ' · from photo' : '');
}
const toLocalInput = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

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
    if (species) continue; // ID photos never move the entry's time or place
    const fresh = taken && Math.abs(Date.now() - taken) <= 30 * 60e3;
    // An older gallery photo can move a NEW entry to when/where it was taken — but only if Bobby says so.
    if (editor.isNew && taken && !fresh && !editor.timeFromPhoto && !editor.askedPhotoTime) {
      editor.askedPhotoTime = true;
      const when = taken.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
      if (confirm(`This photo was taken on ${when}.\n\nMove this entry to that date and time${exif.lat != null ? ' and place' : ''}?\n\nOK = use the photo's date · Cancel = keep it as now`)) {
        editor.timeFromPhoto = true; editor.entry.at = taken.getTime(); editor.entry.tz = deviceTZ();
        if (editor.carriedPlace && $('#placeInput').value === editor.carriedPlace) $('#placeInput').value = '';
        if (exif.lat != null) { editor.entry.lat = exif.lat; editor.entry.lon = exif.lon; editor.entry.acc = null; setGPSText(); }
        updateWhen();
      }
    } else if (fresh && editor.entry.lat == null && exif?.lat != null) {
      editor.entry.lat = exif.lat; editor.entry.lon = exif.lon; setGPSText();   // just-taken photo: its GPS is where you are
    }
  }
  input.value = '';
  renderEditorMedia();
  if (species) { renderChips(); toast(`ID photo added for ${species}`); }
}

const liveMedia = () => [...editor.existing.filter(m => !editor.removed.has(m.id)), ...editor.added];

function renderEditorMedia() {
  editor.editorURLs.forEach(URL.revokeObjectURL); editor.editorURLs = [];
  const u = (b) => { if (!b) return ''; const x = URL.createObjectURL(b); editor.editorURLs.push(x); return x; };
  const all = liveMedia();
  $('#photoStrip').innerHTML = all.filter(m => m.kind === 'photo' && !m.species)
    .map(m => `<div class="ph"><img src="${u(src(m))}" alt=""><button class="rm" data-id="${m.id}" aria-label="Remove photo">✕</button></div>`).join('');
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
    const pu = p && src(p) ? URL.createObjectURL(src(p)) : null;
    if (pu) ed.editorURLs.push(pu);
    return `<span class="sp-chip"><button class="sp-cam${p ? ' has' : ''}" data-s="${U.esc(s)}" aria-label="ID photo for ${U.esc(s)}">${pu ? `<img src="${pu}" alt="">` : '📷'}</button>
      <span class="sp-name">${U.esc(s)}</span><button class="sp-x" data-i="${i}" aria-label="Remove ${U.esc(s)}">✕</button></span>`;
  }).join('');
  $$('#speciesChips .sp-x').forEach(b => b.addEventListener('click', () => {
    const name = ed.entry.species[+b.dataset.i];
    for (const m of liveMedia().filter(m => m.species === name)) removeMedia(m.id, true);
    ed.entry.species.splice(+b.dataset.i, 1); renderChips();
  }));
  $$('#speciesChips .sp-cam').forEach(b => b.addEventListener('click', () => {
    ed.photoForSpecies = b.dataset.s;
    const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (iOS) return $('#speciesPhotoInput').click();
    $('#chooserTitle').textContent = `ID photo · ${b.dataset.s}`;
    $('#chooser').hidden = false;
  }));
  $('#speciesHint').hidden = !ed.entry.species.length;
  // quick picks: your own most-used species first, then Patagonia favourites
  const counts = {};
  (await liveEntries()).forEach(e => (e.species || []).forEach(s => counts[s] = (counts[s] || 0) + 1));
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
  e.updated = Date.now(); e.dirty = true;
  await DB.put('entries', e);
  for (const m of editor.added) await DB.put('media', { ...m, entryId: e.id, updated: Date.now(), dirty: true });
  for (const id of editor.removed) await tombstoneMedia(id);
  Sync.soon();
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  const wasNew = editor.isNew;
  const savedDay = entryDay(e);
  closeEditor();
  if (savedDay !== selectedDay) { selectedDay = savedDay; followToday = savedDay === todayKey(); }
  await renderAll();
  document.querySelector(`.entry[data-id="${e.id}"]`)?.scrollIntoView({ block: 'center' });
  toast(wasNew ? 'Saved to your journal' : 'Entry updated');
}

async function deleteEntry() {
  const id = editor.entry.id;
  const media = (await DB.mediaFor(id)).filter(m => !m.deleted);
  const nPhotos = media.filter(m => m.kind === 'photo').length, nAudio = media.filter(m => m.kind === 'audio').length;
  const what = [nPhotos && `${nPhotos} photo${nPhotos > 1 ? 's' : ''}`, nAudio && `${nAudio} voice note${nAudio > 1 ? 's' : ''}`].filter(Boolean).join(' and ');
  // Step 1 of 2
  if (!confirm(`Delete this entry${what ? ' with its ' + what : ''}?\n\nIt will be removed from both phones and from the cloud.`)) return;
  // Step 2 of 2: typed confirmation, so a double tap can never delete anything
  const typed = prompt('This cannot be undone.\n\nType DELETE to confirm.');
  if (typed === null) return;
  if (typed.trim().toUpperCase() !== 'DELETE') { toast('Not deleted — you need to type DELETE'); return; }
  for (const m of await DB.mediaFor(id)) if (!m.deleted) await tombstoneMedia(m.id);
  const e = await DB.get('entries', id);
  // keep a tombstone so the delete reaches the other phone and the cloud
  await DB.put('entries', { id, at: e.at, tz: e.tz, deleted: true, updated: Date.now(), dirty: true });
  closeEditor(); await renderAll(); Sync.soon(); toast('Entry deleted');
}

// ---------------- install button ----------------
let installPrompt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function renderInstall() {
  const show = !isStandalone() && (installPrompt || isIOS());
  let hidden = false; try { hidden = sessionStorage.getItem('installLater') === '1'; } catch (e) {}
  $('#installBar').hidden = !show || hidden;
  $('#installCard').hidden = !show;
  if (isIOS() && !installPrompt) {
    $('#installText').textContent = 'Install: tap Share ⬆︎ then “Add to Home Screen”';
    $('#installBtn').textContent = 'How?';
    $('#installCardText').textContent = 'In Safari, tap the Share button ⬆︎ at the bottom, then “Add to Home Screen”, then Add.';
    $('#installBtn2').hidden = true;
  }
}
async function doInstall() {
  if (installPrompt) {
    const p = installPrompt;
    installPrompt = null;
    p.prompt();
    const { outcome } = await p.userChoice.catch(() => ({ outcome: 'dismissed' }));
    toast(outcome === 'accepted' ? 'Installing… find Field Journal on your home screen' : 'Not installed — you can try again any time from Backup');
  } else if (isIOS()) {
    alert('In Safari: tap the Share button ⬆︎ at the bottom of the screen, scroll down, tap “Add to Home Screen”, then Add.');
  } else {
    toast('Install isn’t available right now — reload the page and try again', 5000);
  }
  renderInstall();
}
function wireInstall() {
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; renderInstall(); });
  addEventListener('appinstalled', () => { installPrompt = null; renderInstall(); toast('Installed ✓ — open it from your home screen'); });
  $('#installBtn').addEventListener('click', doInstall);
  $('#installBtn2').addEventListener('click', doInstall);
  $('#installLater').addEventListener('click', () => { try { sessionStorage.setItem('installLater', '1'); } catch (e) {} $('#installBar').hidden = true; });
  renderInstall();
}

// ---------------- cloud sync UI ----------------
function wireCloud() {
  Sync.subscribe(renderSyncState);
  $('#cloudSignInBtn').addEventListener('click', async () => {
    const email = $('#cloudEmail').value.trim(), pw = $('#cloudPassword').value;
    if (!email || !pw) return toast('Enter your email and password');
    if (!navigator.onLine) return toast('Signing in needs signal — try again on Wi‑Fi');
    const btn = $('#cloudSignInBtn'); btn.disabled = true; btn.textContent = 'Signing in…';
    try { await Sync.signIn(email, pw); $('#cloudPassword').value = ''; toast('Signed in — syncing now'); }
    catch (e) { toast(e.message, 5000); }
    finally { btn.disabled = false; btn.textContent = 'Sign in'; }
  });
  $('#cloudSyncBtn').addEventListener('click', async () => {
    if (!navigator.onLine) return toast('No signal — your changes are safe on the phone and will sync later');
    await Sync.run(); const st = Sync.state;
    toast(st.status === 'error' ? 'Sync problem: ' + st.error : 'All synced', st.status === 'error' ? 6000 : 2600);
  });
  $('#cloudFreeBtn').addEventListener('click', async () => {
    if (Sync.state.pending) return toast('Sync first — some photos are not in the cloud yet');
    if (!confirm('Remove full-size copies of photos that are safely in the cloud? Small previews stay on the phone, and full photos come back from the cloud when you open them online.')) return;
    const { count, saved } = await Sync.freeUpSpace();
    await renderAll(); renderStorage();
    toast(count ? `Freed ${(saved / 1048576).toFixed(1)} MB from ${count} photos` : 'Nothing to free yet');
  });
  $('#cloudSignOutBtn').addEventListener('click', async () => {
    if (!confirm('Sign out of cloud sync on this phone? Your journal stays on the phone.')) return;
    await Sync.signOut(); toast('Signed out');
  });
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
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d).replace(/\D/g, '');
  const stamp = dayKey(d, tz) + '_' + hm;   // 24-hour, e.g. 2026-12-02_1341
  const tag = U.slug(m.species || (entry?.species || [])[0] || entry?.place || '');
  return `media/${stamp}${tag ? '_' + tag : ''}_${m.species ? 'id' : m.kind}_${m.id.slice(0, 8)}.${EXT[m.mime.split(';')[0]] || 'bin'}`;
}

async function exportBackup() {
  const btn = $('#exportBtn');
  btn.disabled = true; btn.textContent = 'Preparing backup…';
  try {
    const entries = (await liveEntries()).sort((a, b) => a.at - b.at).map(({ dirty, ...e }) => e);
    const media = await liveMediaAll();
    const byId = Object.fromEntries(entries.map(e => [e.id, e]));
    const files = [], mediaIndex = [];
    for (const m of media) {
      const name = mediaFileName(m, byId[m.entryId]);
      const full = m.blob || await Sync.fullBlob(m);   // fetch freed photos back from the cloud when online
      if (!full) continue;
      files.push({ name, data: new Uint8Array(await full.arrayBuffer()) });
      const { blob, thumb, dirty, uploaded, offloaded, needsDownload, ...meta } = m;
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
      if (!cur) { await DB.put('entries', { ...clean, dirty: true }); added++; }
      else if ((e.updated || 0) > (cur.updated || 0)) { await DB.put('entries', { ...clean, dirty: true }); updated++; }
    }
    for (const m of j.media) {
      if (existingMedia.has(m.id) || !files[m.file]) continue;
      const { file: f, ...meta } = m;
      await DB.put('media', { ...meta, blob: new Blob([files[m.file]], { type: m.mime }), dirty: true });
      mediaAdded++;
    }
    await renderAll(); Sync.soon();
    toast(`Merged from ${j.device || 'backup'}: ${added} new, ${updated} updated, ${mediaAdded} photos/recordings`, 5000);
  } catch (e) {
    toast('Could not open backup: ' + e.message, 6000);
  }
}

boot();
