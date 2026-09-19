import type { Address, ReadonlyUint8Array } from '@solana/kit';
import type { WordTriple } from './accounts.ts';
import { BorshReader } from './borsh.ts';
import { EVENT_DISCRIMINATORS, EVENT_NAMES, startsWith } from './discriminators.ts';
import { fromBase64 } from './util.ts';

// Anchor `emit!` events (layouts from program/.../events.rs; SPEC §2.4 names them but not their types).
// Anchor logs them as "Program data: <base64(discriminator ‖ borsh)>".

export type ChalkEvent =
  | { name: 'CheckedIn'; teacher: Address; day: number; idx: number; slot: bigint; slotAge: bigint; words: WordTriple }
  | { name: 'RecheckStarted'; teacher: Address; day: number; fromSlot: bigint; deadlineSlot: bigint }
  | { name: 'RecheckRolled'; teacher: Address; day: number; boundarySlot: bigint; roll: number; hit: boolean }
  | { name: 'Attested'; teacher: Address; day: number; idx: number; flags: number; headcount: number }
  | { name: 'Settled'; teacher: Address; day: number; passing: number; missedRecheck: boolean; amount: bigint };

export function decodeEvent(data: ReadonlyUint8Array): ChalkEvent | null {
  const name = EVENT_NAMES.find((n) => startsWith(data, EVENT_DISCRIMINATORS[n]));
  if (!name) return null;
  const r = new BorshReader(data);
  r.off = 8;
  const teacher = r.pubkey();
  const day = r.u32();
  switch (name) {
    case 'CheckedIn':
      return { name, teacher, day, idx: r.u8(), slot: r.u64(), slotAge: r.u64(), words: [r.u8(), r.u8(), r.u8()] };
    case 'RecheckStarted':
      return { name, teacher, day, fromSlot: r.u64(), deadlineSlot: r.u64() };
    case 'RecheckRolled':
      return { name, teacher, day, boundarySlot: r.u64(), roll: r.u8(), hit: r.bool() };
    case 'Attested':
      return { name, teacher, day, idx: r.u8(), flags: r.u8(), headcount: r.u8() };
    case 'Settled':
      return { name, teacher, day, passing: r.u8(), missedRecheck: r.bool(), amount: r.u64() };
  }
}

const PROGRAM_DATA = 'Program data: ';

/** All Chalk Chain events in a transaction's log messages, in order. Unknown/garbled lines are skipped. */
export function parseEventsFromLogs(logs: readonly string[] | null | undefined): ChalkEvent[] {
  const out: ChalkEvent[] = [];
  for (const line of logs ?? []) {
    if (!line.startsWith(PROGRAM_DATA)) continue;
    try {
      const ev = decodeEvent(fromBase64(line.slice(PROGRAM_DATA.length).trim()));
      if (ev) out.push(ev);
    } catch {
      // not ours
    }
  }
  return out;
}
