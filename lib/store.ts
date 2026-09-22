// On-device storage: IndexedDB first (larger quota, async, doesn't block the
// page), with localStorage as the fallback when IndexedDB isn't available
// (some private-browsing modes) — and a one-time migration of anything an
// older version of the app left in localStorage under the same key.
// Nothing stored here ever leaves the phone.

const DB_NAME = "suraksha-setu";
const STORE = "kv";
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

function lsGet<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? undefined : (JSON.parse(raw) as T);
  } catch {
    return undefined;
  }
}

function lsSet(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota or disabled */ }
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return lsGet<T>(key);
  const v = await tx<T>(db, "readonly", (s) => s.get(key));
  if (v !== undefined) return v;
  const legacy = lsGet<T>(key);
  if (legacy !== undefined) {
    await tx(db, "readwrite", (s) => s.put(legacy, key));
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }
  return legacy;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  if (!db) return lsSet(key, value);
  const ok = await tx(db, "readwrite", (s) => s.put(value, key));
  if (ok === undefined) lsSet(key, value); // write failed (quota) — keep a copy somewhere
}

export async function kvDel(key: string): Promise<void> {
  const db = await openDb();
  if (db) await tx(db, "readwrite", (s) => s.delete(key));
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

export async function kvClearAll(): Promise<void> {
  const db = await openDb();
  if (db) await tx(db, "readwrite", (s) => s.clear());
}
