// SlotHashes sysvar data: u64 LE count, then count × (u64 LE slot, [u8; 32] hash), newest first.

export interface SlotHashEntry {
  slot: bigint;
  hash: Uint8Array;
}

const ENTRY = 40;

export function parseSlotHashes(data: Uint8Array): SlotHashEntry[] {
  if (data.length < 8) throw new Error('SlotHashes data too short');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = view.getBigUint64(0, true);
  if (8n + count * BigInt(ENTRY) > BigInt(data.length)) throw new Error(`SlotHashes claims ${count} entries but data is ${data.length} bytes`);
  const out: SlotHashEntry[] = [];
  for (let i = 0; i < Number(count); i++) {
    const o = 8 + i * ENTRY;
    out.push({ slot: view.getBigUint64(o, true), hash: data.slice(o + 8, o + ENTRY) });
  }
  return out;
}

export function encodeSlotHashes(entries: readonly SlotHashEntry[]): Uint8Array {
  const out = new Uint8Array(8 + entries.length * ENTRY);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, BigInt(entries.length), true);
  entries.forEach((e, i) => {
    const o = 8 + i * ENTRY;
    view.setBigUint64(o, e.slot, true);
    out.set(e.hash, o + 8);
  });
  return out;
}

export function newest(entries: readonly SlotHashEntry[]): SlotHashEntry | undefined {
  return entries[0];
}

/** Binary search (entries are sorted by slot, descending). */
export function find(entries: readonly SlotHashEntry[], slot: bigint | number): SlotHashEntry | undefined {
  const target = BigInt(slot);
  let lo = 0;
  let hi = entries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = entries[mid]!;
    if (e.slot === target) return e;
    if (e.slot > target) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

export { find as findSlotHash, newest as newestSlotHash };
