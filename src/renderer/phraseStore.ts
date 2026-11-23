// Persistent cache of generated speech. Eya's replies are short and templated
// ("Notepad is open."), so once a phrase has been generated it can be played
// back instantly on every later launch instead of being generated again.
//
// Callers own the key, and must include everything that changes the sound
// (engine, voice, version) so a changed voice never plays stale audio.

const DB_NAME = 'eya-tts';
const STORE = 'phrases';

export type StoredAudio = ArrayBuffer | Uint8Array;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise !== null) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

export async function loadAudio(key: string): Promise<StoredAudio | null> {
  const db = await openDb();
  if (db === null) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => {
        const value: unknown = req.result;
        resolve(value instanceof ArrayBuffer || value instanceof Uint8Array ? value : null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function saveAudio(key: string, data: StoredAudio): Promise<void> {
  const db = await openDb();
  if (db === null) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(data, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
