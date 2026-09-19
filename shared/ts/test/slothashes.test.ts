import { describe, expect, it } from 'vitest';
import { encodeSlotHashes, find, newest, parseSlotHashes, toHex } from '../src/index.ts';

function syntheticBuffer(slots: bigint[]): Uint8Array {
  // Built by hand (not with encodeSlotHashes) so the parser is checked against the raw layout.
  const buf = new Uint8Array(8 + slots.length * 40);
  const v = new DataView(buf.buffer);
  v.setBigUint64(0, BigInt(slots.length), true);
  slots.forEach((s, i) => {
    v.setBigUint64(8 + i * 40, s, true);
    buf.fill(Number(s % 256n), 8 + i * 40 + 8, 8 + (i + 1) * 40);
  });
  return buf;
}

describe('SlotHashes', () => {
  const slots = [1000n, 999n, 997n, 996n, 990n, 42n];
  const data = syntheticBuffer(slots);

  it('parses count, slots and hashes, newest first', () => {
    const entries = parseSlotHashes(data);
    expect(entries.map((e) => e.slot)).toEqual(slots);
    expect(toHex(entries[0]!.hash)).toBe('e8'.repeat(32));
    expect(newest(entries)?.slot).toBe(1000n);
  });

  it('finds present slots and misses absent ones', () => {
    const entries = parseSlotHashes(data);
    for (const s of slots) expect(find(entries, s)?.slot).toBe(s);
    expect(find(entries, 998n)).toBeUndefined();
    expect(find(entries, 1001)).toBeUndefined();
    expect(find(entries, 0)).toBeUndefined();
    expect(toHex(find(entries, 42)!.hash)).toBe('2a'.repeat(32));
  });

  it('works on a subarray with a non-zero byteOffset (e.g. from an RPC buffer)', () => {
    const padded = new Uint8Array(data.length + 5);
    padded.set(data, 5);
    expect(parseSlotHashes(padded.subarray(5)).map((e) => e.slot)).toEqual(slots);
  });

  it('round-trips through encodeSlotHashes', () => {
    expect(encodeSlotHashes(parseSlotHashes(data))).toEqual(data);
  });

  it('handles the real sysvar size (512 entries) and rejects truncated data', () => {
    const big = syntheticBuffer(Array.from({ length: 512 }, (_, i) => 5000n - BigInt(i)));
    expect(big.length).toBe(20488);
    const entries = parseSlotHashes(big);
    expect(entries).toHaveLength(512);
    expect(find(entries, 4489n)?.slot).toBe(4489n);
    expect(() => parseSlotHashes(big.subarray(0, 100))).toThrow();
    expect(() => parseSlotHashes(new Uint8Array(4))).toThrow();
  });

  it('empty sysvar', () => {
    const entries = parseSlotHashes(syntheticBuffer([]));
    expect(entries).toEqual([]);
    expect(newest(entries)).toBeUndefined();
    expect(find(entries, 1)).toBeUndefined();
  });
});
