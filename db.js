// Tiny IndexedDB wrapper. Everything stays on the phone; nothing is sent anywhere.
const DB_NAME = 'patagonia-journal';
const DB_VERSION = 1;
let _db;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('entries')) {
        const s = db.createObjectStore('entries', { keyPath: 'id' });
        s.createIndex('at', 'at');
      }
      if (!db.objectStoreNames.contains('media')) {
        const m = db.createObjectStore('media', { keyPath: 'id' });
        m.createIndex('entryId', 'entryId');
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function reqP(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

const DB = {
  put: (store, value) => tx(store, 'readwrite', s => reqP(s.put(value))),
  get: (store, key) => tx(store, 'readonly', s => reqP(s.get(key))),
  del: (store, key) => tx(store, 'readwrite', s => reqP(s.delete(key))),
  all: (store) => tx(store, 'readonly', s => reqP(s.getAll())),
  keys: (store) => tx(store, 'readonly', s => reqP(s.getAllKeys())),
  mediaFor: (entryId) => tx('media', 'readonly', s => reqP(s.index('entryId').getAll(entryId))),
  async setting(key, fallback) {
    const row = await DB.get('settings', key);
    return row ? row.value : fallback;
  },
  setSetting: (key, value) => DB.put('settings', { key, value }),
};
