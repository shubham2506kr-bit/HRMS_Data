const DB_NAME = 'humanos-offline';
const STORE = 'outbox';
const VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Queue an offline mutation; returns the queued record id. */
export async function queueOffline<T = unknown>(payload: T): Promise<number> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).add({ payload, queued_at: new Date().toISOString() });
    req.onsuccess = () => resolve(req.result as number);
    req.onerror = () => reject(req.error);
    // Close the connection: a lingering one blocks deleteOfflineDb() on logout.
    tx.oncomplete = () => db.close();
  });
}

/** List all queued items. */
export async function listQueue<T = unknown>(): Promise<{ id: number; payload: T; queued_at: string }[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as { id: number; payload: T; queued_at: string }[]);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

/** Remove a flushed item. */
export async function dropQueued(id: number): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Delete the whole offline outbox.
 *
 * Called during logout teardown: queued mutations belong to the session that
 * created them and must never be flushed under the next user's token, nor left
 * on disk for the next person to use this browser.
 */
export function deleteOfflineDb(): Promise<void> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(DB_NAME);
      // Resolve on every outcome — teardown must never hang on a blocked
      // delete (another tab holding a connection open).
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

export function isOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine;
}

export function onConnectivityChange(cb: (online: boolean) => void): () => void {
  const up = () => cb(true);
  const down = () => cb(false);
  window.addEventListener('online', up);
  window.addEventListener('offline', down);
  return () => {
    window.removeEventListener('online', up);
    window.removeEventListener('offline', down);
  };
}