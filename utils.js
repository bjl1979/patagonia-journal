// Helpers: ids, escaping, EXIF reading, photo resizing, and a tiny ZIP writer/reader
// (store-only, no compression — photos and audio are already compressed).

const U = {};

U.uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));

U.esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

U.slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);

// ---------- EXIF (JPEG only): capture time + GPS ----------
U.readExif = async (file) => {
  try {
    const buf = await file.slice(0, 256 * 1024).arrayBuffer();
    const v = new DataView(buf);
    if (v.getUint16(0) !== 0xFFD8) return null;
    let off = 2;
    while (off < v.byteLength - 4) {
      const marker = v.getUint16(off);
      const size = v.getUint16(off + 2);
      if (marker === 0xFFE1 && v.getUint32(off + 4) === 0x45786966) {
        return parseTiff(v, off + 10);
      }
      if ((marker & 0xFF00) !== 0xFF00) break;
      off += 2 + size;
    }
  } catch (e) { /* ignore */ }
  return null;

  function parseTiff(v, t) {
    const le = v.getUint16(t) === 0x4949;
    const u16 = o => v.getUint16(t + o, le);
    const u32 = o => v.getUint32(t + o, le);
    const out = {};
    const readIFD = (o) => {
      const tags = {};
      const n = u16(o);
      for (let i = 0; i < n; i++) {
        const e = o + 2 + i * 12;
        tags[u16(e)] = { type: u16(e + 2), count: u32(e + 4), valOff: e + 8 };
      }
      return tags;
    };
    const str = (tag) => {
      const off = tag.count > 4 ? u32(tag.valOff) : tag.valOff;
      let s = '';
      for (let i = 0; i < tag.count - 1; i++) s += String.fromCharCode(v.getUint8(t + off + i));
      return s;
    };
    const rationals = (tag) => {
      const off = u32(tag.valOff);
      const r = [];
      for (let i = 0; i < tag.count; i++) r.push(u32(off + i * 8) / (u32(off + i * 8 + 4) || 1));
      return r;
    };
    const ifd0 = readIFD(u32(4));
    if (ifd0[0x8769]) {
      const ex = readIFD(u32(ifd0[0x8769].valOff));
      if (ex[0x9003]) out.taken = str(ex[0x9003]); // "YYYY:MM:DD HH:MM:SS"
    }
    if (!out.taken && ifd0[0x0132]) out.taken = str(ifd0[0x0132]);
    if (ifd0[0x8825]) {
      const g = readIFD(u32(ifd0[0x8825].valOff));
      if (g[2] && g[4]) {
        const toDeg = a => a[0] + a[1] / 60 + a[2] / 3600;
        let lat = toDeg(rationals(g[2])), lon = toDeg(rationals(g[4]));
        if (g[1] && String.fromCharCode(v.getUint8(t + g[1].valOff)) === 'S') lat = -lat;
        if (g[3] && String.fromCharCode(v.getUint8(t + g[3].valOff)) === 'W') lon = -lon;
        if (isFinite(lat) && isFinite(lon)) { out.lat = lat; out.lon = lon; }
      }
    }
    return out;
  }
};

// EXIF time has no zone; treat it as the phone's local wall clock.
U.exifToDate = (s) => {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(s || '');
  return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
};

// ---------- Resize a photo to keep storage sane (max 2048px, JPEG) ----------
U.resizeImage = (file, max = 2048, quality = 0.85) => new Promise((resolve) => {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    let { width: w, height: h } = img;
    const scale = Math.min(1, max / Math.max(w, h));
    w = Math.round(w * scale); h = Math.round(h * scale);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(url);
    c.toBlob(b => resolve(b || file), 'image/jpeg', quality);
  };
  img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
  img.src = url;
});

// ---------- ZIP (store method) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// files: [{ name, data: Uint8Array }]
U.makeZip = (files) => {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(lh.buffer, name, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true); ch.setUint32(20, size, true);
    ch.setUint32(24, size, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((a, p) => a + (p.byteLength ?? p.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
};

// Reads store-only zips (the kind this app writes). Returns { name: Uint8Array }.
U.readZip = async (blob) => {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const v = new DataView(buf.buffer);
  let e = buf.length - 22;
  while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('Not a zip file');
  const count = v.getUint16(e + 10, true);
  let p = v.getUint32(e + 16, true);
  const dec = new TextDecoder();
  const out = {};
  for (let i = 0; i < count; i++) {
    const method = v.getUint16(p + 10, true);
    const size = v.getUint32(p + 20, true);
    const nl = v.getUint16(p + 28, true), xl = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nl));
    if (method !== 0) throw new Error('This backup was re-compressed by another app. Use the original file.');
    const lnl = v.getUint16(local + 26, true), lxl = v.getUint16(local + 28, true);
    const start = local + 30 + lnl + lxl;
    out[name] = buf.subarray(start, start + size);
    p += 46 + nl + xl + cl;
  }
  return out;
};
