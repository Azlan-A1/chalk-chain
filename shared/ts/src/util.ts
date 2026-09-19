import { getAddressDecoder, getAddressEncoder, getBase64Decoder, getBase64Encoder, type Address } from '@solana/kit';

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error(`invalid hex: ${hex}`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  return getBase64Decoder().decode(bytes);
}

export function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(getBase64Encoder().encode(b64));
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 32-byte public key of a base58 address. */
export function addressBytes(addr: Address): Uint8Array {
  return new Uint8Array(getAddressEncoder().encode(addr));
}

export function bytesToAddress(bytes: Uint8Array): Address {
  if (bytes.length !== 32) throw new Error(`address must be 32 bytes, got ${bytes.length}`);
  return getAddressDecoder().decode(bytes);
}

/** Deep-converts bigint → decimal string and Uint8Array → hex so a value can go through JSON.stringify. */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return toHex(value);
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJsonSafe(v);
    return out;
  }
  return value;
}
