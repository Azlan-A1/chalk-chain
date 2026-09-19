import { isPhotoStale } from './logic.ts';

// Photos committed on-chain but not yet verified, kept only on this phone so a failed /verify can be
// retried with the exact committed bytes. Deleted once verified, or after 2 days.
// A separate database from key.ts so the teacher key store never needs a version upgrade.

const DB = 'chalk-chain-photos';
const STORE = 'photos';

export interface StoredPhoto {
  teacher: string;
  day: number;
  idx: number;
  bytes: ArrayBuffer;
  savedAt: number;
}

const keyOf = (teacher: string, day: number, idx: number) => `${teacher}:${day}:${idx}`;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error ?? req.error);
      t.onabort = () => reject(t.error ?? new Error('aborted'));
    });
  } finally {
    db.close();
  }
}

export async function savePhoto(teacher: string, day: number, idx: number, bytes: Uint8Array): Promise<void> {
  const rec: StoredPhoto = { teacher, day, idx, bytes: bytes.slice().buffer, savedAt: Date.now() };
  await run('readwrite', (s) => s.put(rec, keyOf(teacher, day, idx)));
}

export async function deletePhoto(teacher: string, day: number, idx: number): Promise<void> {
  await run('readwrite', (s) => s.delete(keyOf(teacher, day, idx)));
}

export async function loadPhoto(teacher: string, day: number, idx: number): Promise<StoredPhoto | undefined> {
  return run<StoredPhoto | undefined>('readonly', (s) => s.get(keyOf(teacher, day, idx)));
}

export async function listPhotos(teacher?: string): Promise<StoredPhoto[]> {
  const all = await run<StoredPhoto[]>('readonly', (s) => s.getAll());
  return teacher === undefined ? all : all.filter((p) => p.teacher === teacher);
}

export function photoBlob(p: StoredPhoto): Blob {
  return new Blob([p.bytes], { type: 'image/jpeg' });
}

/** Called on boot. Returns how many were removed; never throws (storage may be unavailable). */
export async function purgeOldPhotos(now = Date.now()): Promise<number> {
  try {
    const stale = (await listPhotos()).filter((p) => isPhotoStale(p.savedAt, now));
    for (const p of stale) await deletePhoto(p.teacher, p.day, p.idx);
    return stale.length;
  } catch {
    return 0;
  }
}

export async function clearPhotos(): Promise<void> {
  await run('readwrite', (s) => s.clear());
}
