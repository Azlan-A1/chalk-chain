import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { wordlist, type Lang } from './wordlists.ts';

// SPEC §1. All inputs/outputs are raw 32-byte arrays unless noted.

export const DOMAIN = 'chalk-chain';
const DOMAIN_BYTES = new TextEncoder().encode(DOMAIN);

export type WordIndices = [number, number, number];

export function sha256(...parts: Uint8Array[]): Uint8Array {
  const h = nobleSha256.create();
  for (const p of parts) h.update(p);
  return h.digest();
}

function need32(name: string, b: Uint8Array): void {
  if (!(b instanceof Uint8Array) || b.length !== 32) throw new Error(`${name} must be 32 bytes`);
}

export function u32le(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) throw new Error(`not a u32: ${n}`);
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

/** prev_0 = sha256("chalk-chain" ‖ teacher ‖ day_le) */
export function prev0(teacher: Uint8Array, day: number): Uint8Array {
  need32('teacher', teacher);
  return sha256(DOMAIN_BYTES, teacher, u32le(day));
}

/** seed_k = sha256(slot_hash ‖ teacher ‖ prev_{k-1}) */
export function seed(slotHash: Uint8Array, teacher: Uint8Array, prev: Uint8Array): Uint8Array {
  need32('slotHash', slotHash);
  need32('teacher', teacher);
  need32('prev', prev);
  return sha256(slotHash, teacher, prev);
}

export function wordIndices(seedBytes: Uint8Array): WordIndices {
  need32('seed', seedBytes);
  return [seedBytes[0]!, seedBytes[1]!, seedBytes[2]!];
}

/** prev_k = sha256(photo_sha256 ‖ seed_k) */
export function commit(photoHash: Uint8Array, seedBytes: Uint8Array): Uint8Array {
  need32('photoHash', photoHash);
  need32('seed', seedBytes);
  return sha256(photoHash, seedBytes);
}

/** SHA-256 of the exact image bytes that get uploaded. */
export function photoHash(imageBytes: Uint8Array): Uint8Array {
  return sha256(imageBytes);
}

export function wordsFor(indices: readonly number[], lang: Lang): string[] {
  const list = wordlist(lang);
  return indices.map((i) => {
    const w = list[i];
    if (w === undefined) throw new Error(`word index out of range: ${i}`);
    return w;
  });
}

/** prev for the next link: prev_0 when the chain is empty, else the last stored commit. */
export function prevFor(teacher: Uint8Array, day: number, lastCommit?: Uint8Array | null): Uint8Array {
  return lastCommit ?? prev0(teacher, day);
}

export interface Challenge {
  seed: Uint8Array;
  indices: WordIndices;
  words: string[];
}

/** Words to chalk for a given slot hash and prev. */
export function challenge(slotHash: Uint8Array, teacher: Uint8Array, prev: Uint8Array, lang: Lang): Challenge {
  const s = seed(slotHash, teacher, prev);
  const indices = wordIndices(s);
  return { seed: s, indices, words: wordsFor(indices, lang) };
}

export interface DerivedLink {
  idx: number;
  prev: Uint8Array;
  seed: Uint8Array;
  words: WordIndices;
  commit: Uint8Array;
}

export function deriveLink(idx: number, slotHash: Uint8Array, teacher: Uint8Array, prev: Uint8Array, photo: Uint8Array): DerivedLink {
  const s = seed(slotHash, teacher, prev);
  return { idx, prev, seed: s, words: wordIndices(s), commit: commit(photo, s) };
}

/** Whole chain for a day, mirroring chalkwords.chain(). */
export function deriveChain(teacher: Uint8Array, day: number, slotHashes: Uint8Array[], photoHashes: Uint8Array[]): DerivedLink[] {
  const n = Math.min(slotHashes.length, photoHashes.length);
  const out: DerivedLink[] = [];
  let prev = prev0(teacher, day);
  for (let k = 0; k < n; k++) {
    const link = deriveLink(k, slotHashes[k]!, teacher, prev, photoHashes[k]!);
    out.push(link);
    prev = link.commit;
  }
  return out;
}

/** UTC day number (unix_timestamp / 86400) the program compares against. */
export function dayNumber(date: Date = new Date()): number {
  return Math.floor(date.getTime() / 86_400_000);
}
