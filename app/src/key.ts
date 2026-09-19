import {
  createKeyPairSignerFromPrivateKeyBytes,
  createSignerFromKeyPair,
  generateKeyPair,
  type KeyPairSigner,
} from '@solana/kit';

// The teacher's key lives only in this browser's IndexedDB and is never shown.
// Native Ed25519 CryptoKeys are non-extractable and structured-cloneable, so we store the CryptoKeyPair.
// Old browsers without Ed25519 get the userspace polyfill; its keys can't be cloned into IndexedDB,
// so there we keep the 32-byte seed instead.

const DB = 'chalk-chain';
const STORE = 'keys';
const ID = 'teacher';

type Stored = { kind: 'cryptokey'; keyPair: CryptoKeyPair } | { kind: 'seed'; seed: Uint8Array };

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

let nativeEd25519: Promise<boolean> | null = null;

function hasNativeEd25519(): Promise<boolean> {
  nativeEd25519 ??= crypto.subtle
    .generateKey('Ed25519', false, ['sign', 'verify'])
    .then(() => true)
    .catch(() => false)
    .then(async (ok) => {
      if (!ok) (await import('@solana/webcrypto-ed25519-polyfill')).install();
      return ok;
    });
  return nativeEd25519;
}

let cached: Promise<KeyPairSigner> | null = null;

export function loadTeacherSigner(): Promise<KeyPairSigner> {
  cached ??= loadOrCreate().catch((e) => {
    cached = null;
    throw e;
  });
  return cached;
}

async function loadOrCreate(): Promise<KeyPairSigner> {
  if (!globalThis.isSecureContext || !globalThis.crypto?.subtle) {
    throw new Error('This page must be opened over https:// (or on localhost) to keep your key safe.');
  }
  const native = await hasNativeEd25519();
  const stored = await tx<Stored | undefined>('readonly', (s) => s.get(ID));
  if (stored?.kind === 'cryptokey') return createSignerFromKeyPair(stored.keyPair);
  if (stored?.kind === 'seed') return createKeyPairSignerFromPrivateKeyBytes(stored.seed);

  if (native) {
    const keyPair = await generateKeyPair();
    try {
      await tx('readwrite', (s) => s.put({ kind: 'cryptokey', keyPair } satisfies Stored, ID));
      return createSignerFromKeyPair(keyPair);
    } catch {
      // Some browsers refuse to clone Ed25519 keys; fall through to the seed path.
    }
  }
  const seed = crypto.getRandomValues(new Uint8Array(32));
  await tx('readwrite', (s) => s.put({ kind: 'seed', seed } satisfies Stored, ID));
  return createKeyPairSignerFromPrivateKeyBytes(seed);
}

/** Demo only: forget this teacher. A new key (a new teacher) is made on next load. */
export async function forgetTeacher(): Promise<void> {
  cached = null;
  await tx('readwrite', (s) => s.delete(ID));
}
