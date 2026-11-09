// Plans: sections of ideas and checklists (things to buy, shot ideas, packing…). No dates.
// Stored as rows in the same 'entries' store with kind 'plan-section' / 'plan-item', so they
// sync between phones exactly like journal entries (one row per item: ticking different
// items on two phones never clashes).
const Plans = (() => {
  const ICONS = ['🎯', '🛒', '📷', '🎒', '✈️', '🏔', '🐾', '🍽', '🏨', '💡', '📚', '⭐'];
  const TINTS = { '🎯': '#efe6f5', '🛒': '#fbefe2', '📷': '#e3eeec', '🎒': '#e6efe0', '✈️': '#e5ecf6', '🏔': '#e5ecf6', '🐾': '#f3eadf', '🍽': '#fbefe2', '🏨': '#efe6f5', '💡': '#fbf3d9', '📚': '#e6efe0', '⭐': '#fbf3d9' };
  const BAR = { '🎯': '#7b5ea7', '🛒': '#c2793a', '📷': '#2f6f73', '🎒': '#3f8f4e', '✈️': '#2a6cb0', '🏔': '#4f7d8a', '🐾': '#a0782b', '🍽': '#c2793a', '🏨': '#7b5ea7', '💡': '#a0782b', '📚': '#3f8f4e', '⭐': '#a0782b' };
  const TEMPLATES = {
    blank: { name: 'Blank list', sub: 'Your own items', icon: '💡', items: [] },
    buy: { name: 'Things to buy', sub: 'Shopping ideas', icon: '🛒', items: ['Circular polariser for the long lens', 'Windproof gloves that work with the camera', 'Buff / neck gaiter', 'Spare memory cards', 'Lens rain cover'] },
    shots: { name: 'Shot ideas', sub: 'Photos to try', icon: '🎯', items: ['Puma at first light', 'Condor in flight against the towers', 'Guanaco silhouette at sunset', 'Cuernos reflected in Lago Pehoé', 'Star trails over the Torres', 'Icebergs on Lago Grey — wide and moody'] },
    packing: { name: 'Packing list', sub: 'With groups', icon: '🎒', items: ['# Camera', 'Camera body + batteries', 'Long lens', 'Wide lens', 'Charger and cables', '# Clothes', 'Waterproof shell', 'Warm layers', 'Hiking boots'] },
  };

  let rows = [];            // live plan rows
  let openId = null;        // section being viewed
  let filter = 'all';
  let editing = null;       // item being edited
  let newTpl = 'blank', newIcon = '💡';

  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const esc = (s) => U.esc(s);
  const sections = () => rows.filter(r => r.kind === 'plan-section').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const itemsOf = (sid) => rows.filter(r => r.kind === 'plan-item' && r.sectionId === sid).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const tasks = (sid) => itemsOf(sid).filter(i => !i.heading);

  async function load() { rows = (await DB.all('entries')).filter(e => !e.deleted && (e.kind === 'plan-section' || e.kind === 'plan-item')); }
  async function save(row) {
    const now = Date.now();
    row.updated = Math.max(now, (row.updated || 0) + 1); row.dirty = true;
    if (!row.at) row.at = row.created || now;
    if (!row.tz) row.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    await DB.put('entries', row);
    Sync.soon();
  }
  async function remove(row) {
    await DB.put('entries', { id: row.id, kind: row.kind, at: row.at || Date.now(), tz: row.tz, deleted: true, updated: Date.now(), dirty: true });
    Sync.soon();
  }

  // ---------- rendering ----------
  async function render() {
    await load();
    if (openId && !sections().some(s => s.id === openId)) openId = null;
    openId ? renderSection() : renderHome();
  }

  function renderHome() {
    const secs = sections();
    const all = rows.filter(r => r.kind === 'plan-item' && !r.heading);
    const done = all.filter(i => i.done).length;
    $('#plans').innerHTML = `
      <div class="ptitle"><h2>Plans</h2><span>${secs.length ? `${secs.length} section${secs.length > 1 ? 's' : ''} · ${done} of ${all.length} done` : ''}</span></div>
      ${secs.length ? '' : `<div class="empty small-empty"><p>Make lists of things to buy, photos you want to take, what to pack — anything you're planning.</p></div>`}
      ${secs.map(s => {
        const t = tasks(s.id), d = t.filter(i => i.done).length, left = t.filter(i => !i.done);
        const pct = t.length ? Math.round(d / t.length * 100) : 0, complete = t.length && d === t.length;
        const sub = !t.length ? 'No items yet' : complete ? 'All done' : left.slice(0, 3).map(i => i.text).join(' · ');
        return `<button class="psec" data-id="${s.id}">
          <span class="pic" style="background:${TINTS[s.icon] || 'var(--chip)'}">${esc(s.icon || '💡')}</span>
          <span class="pb"><span class="pn">${esc(s.title)}</span><span class="pm">${esc(sub)}</span>
            <span class="prog"><i style="width:${pct}%;background:${BAR[s.icon] || 'var(--accent)'}"></i></span></span>
          <span class="pc">${complete ? '<span class="done-tag">Done</span>' : `${d}/${t.length}`}</span></button>`;
      }).join('')}
      <button class="newsec" id="newSecBtn">＋ New section</button>`;
    $$('#plans .psec').forEach(b => b.addEventListener('click', () => { openId = b.dataset.id; filter = 'all'; renderSection(); scrollTo(0, 0); }));
    $('#newSecBtn').addEventListener('click', openNewSection);
  }

  function renderSection() {
    const s = sections().find(x => x.id === openId);
    if (!s) { openId = null; return renderHome(); }
    const all = itemsOf(s.id), t = all.filter(i => !i.heading), d = t.filter(i => i.done).length;
    const show = (i) => i.heading || filter === 'all' || (filter === 'todo' ? !i.done : i.done);
    // hide headings with nothing visible under them when filtering
    const visible = [];
    all.forEach((i, idx) => {
      if (!show(i)) return;
      if (i.heading && filter !== 'all') {
        const next = all.slice(idx + 1); const end = next.findIndex(n => n.heading);
        if (!(end < 0 ? next : next.slice(0, end)).some(show)) return;
      }
      visible.push(i);
    });
    $('#plans').innerHTML = `
      <div class="pback"><button class="link" id="plBack">‹ Plans</button><button class="link pmore" id="plMore" aria-label="Section options">⋯</button></div>
      <div class="pshead"><span class="pic big" style="background:${TINTS[s.icon] || 'var(--chip)'}">${esc(s.icon || '💡')}</span>
        <div><h2>${esc(s.title)}</h2><div class="pm">${t.length ? `${d} of ${t.length} done` : 'No items yet'}</div></div></div>
      ${t.length ? `<div class="pfilters">${[['all', 'All'], ['todo', `To do · ${t.length - d}`], ['done', `Done · ${d}`]].map(([k, l]) => `<button data-f="${k}" class="${filter === k ? 'on' : ''}">${l}</button>`).join('')}</div>` : ''}
      ${visible.length ? `<div class="plist">${visible.map(i => i.heading
        ? `<button class="pgrp" data-id="${i.id}">${esc(i.text)}</button>`
        : `<div class="pit${i.done ? ' done' : ''}"><button class="pcb${i.done ? ' on' : ''}" data-id="${i.id}" aria-label="${i.done ? 'Mark not done' : 'Mark done'}">${i.done ? '✓' : ''}</button>
            <button class="pt" data-id="${i.id}">${esc(i.text)}${i.note ? `<small>${esc(i.note)}</small>` : ''}</button></div>`).join('')}</div>`
        : `<p class="muted small center">${t.length ? 'Nothing here.' : 'Add your first item below.'}</p>`}
      <div class="paddrow"><input id="plAdd" placeholder="Add an item…" enterkeyhint="done"><button class="btn primary" id="plAddBtn">Add</button></div>
      <button class="link small" id="plAddHead">＋ Add a heading to group items</button>`;
    $('#plBack').addEventListener('click', () => { openId = null; renderHome(); scrollTo(0, 0); });
    $('#plMore').addEventListener('click', () => sectionMenu(s));
    $$('#plans .pfilters button').forEach(b => b.addEventListener('click', () => { filter = b.dataset.f; renderSection(); }));
    $$('#plans .pcb').forEach(b => b.addEventListener('click', async () => {
      const it = rows.find(r => r.id === b.dataset.id); it.done = !it.done; await save(it); renderSection();
    }));
    $$('#plans .pt, #plans .pgrp').forEach(b => b.addEventListener('click', () => openItem(b.dataset.id)));
    const add = async (heading = false) => {
      const inp = $('#plAdd'); const text = inp.value.trim();
      if (!text) { inp.focus(); return toast(heading ? 'Type the heading first, then tap Add a heading' : 'Type an item first'); }
      const max = Math.max(0, ...itemsOf(s.id).map(i => i.order ?? 0));
      await save({ id: U.uid(), kind: 'plan-item', sectionId: s.id, text, note: '', done: false, heading, order: max + 1, created: Date.now() });
      await load(); renderSection(); setTimeout(() => $('#plAdd')?.focus(), 30);
    };
    $('#plAddBtn').addEventListener('click', () => add(false));
    $('#plAdd').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(false); } });
    $('#plAddHead').addEventListener('click', () => add(true));
  }

  // ---------- item editor ----------
  function openItem(id) {
    const it = rows.find(r => r.id === id); if (!it) return;
    editing = it;
    $('#plItemTitle').textContent = it.heading ? 'Edit heading' : 'Edit item';
    $('#plItemText').value = it.text; $('#plItemNote').value = it.note || '';
    $('#plItemNoteWrap').hidden = !!it.heading;
    $('#plItemSheet').hidden = false;
  }
  function closeItem() { editing = null; $('#plItemSheet').hidden = true; }
  async function moveItem(dir) {
    const list = itemsOf(editing.sectionId), i = list.findIndex(x => x.id === editing.id), j = i + dir;
    if (j < 0 || j >= list.length) return toast(dir < 0 ? 'Already at the top' : 'Already at the bottom');
    const other = list[j], a = editing.order ?? i, b = other.order ?? j;
    editing.order = b; other.order = a === b ? a + dir * -1 : a;
    await save(editing); await save(other); await load(); renderSection();
    toast(dir < 0 ? 'Moved up' : 'Moved down', 1200);
  }

  // ---------- section menu / new section ----------
  function sectionMenu(s) {
    $('#plSecName').value = s.title; newIcon = s.icon || '💡';
    $('#plSecHead').textContent = 'Edit section';
    $('#plTplWrap').hidden = true; $('#plSecExtra').hidden = false;
    $('#plSecSave').textContent = 'Save';
    $('#plSecSheet').dataset.edit = s.id;
    renderIconPicker(); $('#plSecSheet').hidden = false;
  }
  function openNewSection() {
    newTpl = 'blank'; newIcon = '💡';
    $('#plSecName').value = ''; $('#plSecHead').textContent = 'New section';
    $('#plTplWrap').hidden = false; $('#plSecExtra').hidden = true;
    $('#plSecSave').textContent = 'Create section';
    delete $('#plSecSheet').dataset.edit;
    renderIconPicker(); renderTemplates(); $('#plSecSheet').hidden = false;
    setTimeout(() => $('#plSecName').focus(), 50);
  }
  function renderIconPicker() {
    $('#plIcons').innerHTML = ICONS.map(i => `<button class="${i === newIcon ? 'on' : ''}" data-i="${i}">${i}</button>`).join('');
    $$('#plIcons button').forEach(b => b.addEventListener('click', () => { newIcon = b.dataset.i; renderIconPicker(); }));
  }
  function renderTemplates() {
    $('#plTpls').innerHTML = Object.entries(TEMPLATES).map(([k, t]) => `<button class="ptpl${k === newTpl ? ' on' : ''}" data-k="${k}"><b>${t.name}</b>${t.sub}</button>`).join('');
    $$('#plTpls .ptpl').forEach(b => b.addEventListener('click', () => {
      const prev = TEMPLATES[newTpl];
      newTpl = b.dataset.k; const t = TEMPLATES[newTpl];
      if (!$('#plSecName').value.trim() || $('#plSecName').value === prev.name) $('#plSecName').value = newTpl === 'blank' ? '' : t.name;
      newIcon = t.icon; renderIconPicker(); renderTemplates();
    }));
  }
  async function saveSection() {
    const name = $('#plSecName').value.trim();
    if (!name) { $('#plSecName').focus(); return toast('Give the section a name'); }
    const editId = $('#plSecSheet').dataset.edit;
    if (editId) {
      const s = rows.find(r => r.id === editId); s.title = name; s.icon = newIcon; await save(s);
    } else {
      const max = Math.max(0, ...sections().map(x => x.order ?? 0));
      const s = { id: U.uid(), kind: 'plan-section', title: name, icon: newIcon, order: max + 1, created: Date.now() };
      await save(s);
      let n = 0;
      for (const line of TEMPLATES[newTpl].items) {
        const heading = line.startsWith('# ');
        await save({ id: U.uid(), kind: 'plan-item', sectionId: s.id, text: heading ? line.slice(2) : line, note: '', done: false, heading, order: ++n, created: Date.now() + n });
      }
      openId = s.id; filter = 'all';
    }
    $('#plSecSheet').hidden = true;
    await render(); scrollTo(0, 0);
  }

  function wire() {
    $('#plSecCancel').addEventListener('click', () => { $('#plSecSheet').hidden = true; });
    $('#plSecSave').addEventListener('click', saveSection);
    $('#plSecName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveSection(); } });
    $('#plSecSheet').addEventListener('click', (e) => { if (e.target.id === 'plSecSheet') $('#plSecSheet').hidden = true; });
    $('#plClearDone').addEventListener('click', async () => {
      const id = $('#plSecSheet').dataset.edit, done = tasks(id).filter(i => i.done);
      if (!done.length) return toast('No ticked items to clear');
      if (!confirm(`Remove ${done.length} ticked item${done.length > 1 ? 's' : ''} from this section?`)) return;
      for (const i of done) await remove(i);
      $('#plSecSheet').hidden = true; await render(); toast('Ticked items cleared');
    });
    $('#plUntickAll').addEventListener('click', async () => {
      const id = $('#plSecSheet').dataset.edit, done = tasks(id).filter(i => i.done);
      if (!done.length) return toast('Nothing is ticked');
      for (const i of done) { i.done = false; await save(i); }
      $('#plSecSheet').hidden = true; await render(); toast('All items unticked');
    });
    $('#plDelSec').addEventListener('click', async () => {
      const id = $('#plSecSheet').dataset.edit, s = rows.find(r => r.id === id), n = itemsOf(id).length;
      if (!confirm(`Delete the section “${s.title}”${n ? ` and its ${n} item${n > 1 ? 's' : ''}` : ''}?\n\nIt will be removed from both phones.`)) return;
      const typed = prompt('This cannot be undone.\n\nType DELETE to confirm.');
      if (typed === null) return;
      if (typed.trim().toUpperCase() !== 'DELETE') return toast('Not deleted — you need to type DELETE');
      for (const i of itemsOf(id)) await remove(i);
      await remove(s);
      $('#plSecSheet').hidden = true; openId = null; await render(); toast('Section deleted');
    });
    $('#plItemCancel').addEventListener('click', closeItem);
    $('#plItemSheet').addEventListener('click', (e) => { if (e.target.id === 'plItemSheet') closeItem(); });
    $('#plItemSave').addEventListener('click', async () => {
      const text = $('#plItemText').value.trim(); if (!text) return toast('The item needs some text');
      editing.text = text; editing.note = $('#plItemNote').value.trim(); await save(editing); closeItem(); await render();
    });
    $('#plItemUp').addEventListener('click', () => moveItem(-1));
    $('#plItemDown').addEventListener('click', () => moveItem(1));
    $('#plItemDel').addEventListener('click', async () => {
      if (!confirm(`Delete “${editing.text}”?`)) return;
      await remove(editing); closeItem(); await render(); toast('Deleted');
    });
  }

  // for the backup file
  async function exportData() {
    await load();
    return sections().map(s => ({ title: s.title, icon: s.icon, items: itemsOf(s.id).map(i => i.heading ? { heading: i.text } : { text: i.text, note: i.note || undefined, done: !!i.done }) }));
  }

  async function home() { openId = null; await render(); scrollTo(0, 0); }

  return { render, home, wire, exportData, isPlan: (e) => e.kind === 'plan-section' || e.kind === 'plan-item' };
})();
