import { find, type SlotHashEntry } from '@chalk/shared';

// roll_recheck boundary choice (SPEC §2.4): boundary % interval == 0, boundary > last link slot,
// boundary > last_rolled_boundary, boundary <= now, and boundary must still be in SlotHashes.

export interface BoundaryInput {
  currentSlot: bigint;
  interval: bigint;
  lastLinkSlot: bigint;
  lastRolledBoundary: bigint;
  /** SlotHashes entries, newest first. Skipped slots are absent, so we step back to older boundaries. */
  slotHashes: readonly SlotHashEntry[];
}

/** The newest boundary slot that roll_recheck would accept, or null if none is available yet. */
export function latestRollableBoundary(i: BoundaryInput): bigint | null {
  if (i.interval <= 0n || i.slotHashes.length === 0) return null;
  const floor = i.lastLinkSlot > i.lastRolledBoundary ? i.lastLinkSlot : i.lastRolledBoundary;
  const oldest = i.slotHashes[i.slotHashes.length - 1]!.slot;
  for (let b = (i.currentSlot / i.interval) * i.interval; b > floor && b >= oldest; b -= i.interval) {
    if (find(i.slotHashes, b)) return b;
  }
  return null;
}

/** First boundary strictly after `slot`. */
export function nextBoundary(slot: bigint, interval: bigint): bigint {
  return (slot / interval + 1n) * interval;
}

/** The Day fields a roll depends on (a DayAccount fits). */
export interface DayLike {
  settled: boolean;
  recheckPending: boolean;
  nLinks: number;
  lastRolledBoundary: bigint;
  links: readonly { slot: bigint }[];
}

export interface RollView {
  currentSlot: bigint;
  interval: bigint;
  slotHashes: readonly SlotHashEntry[];
}

export type RollPlan =
  | { kind: 'missing' }
  | { kind: 'settled' }
  | { kind: 'pending' }
  | { kind: 'wait'; nextBoundary: bigint | null }
  | { kind: 'roll'; boundarySlot: bigint };

/** What roll_recheck can do for this day now. `rolledFloor` is a boundary already rolled but maybe not visible on-chain yet. */
export function planRoll(day: DayLike | null, v: RollView, rolledFloor = 0n): RollPlan {
  if (!day) return { kind: 'missing' };
  if (day.settled) return { kind: 'settled' };
  if (day.recheckPending) return { kind: 'pending' };
  const last = day.links[day.nLinks - 1];
  if (!last) return { kind: 'missing' };
  const lastRolledBoundary = day.lastRolledBoundary > rolledFloor ? day.lastRolledBoundary : rolledFloor;
  const b = latestRollableBoundary({ ...v, lastLinkSlot: last.slot, lastRolledBoundary });
  if (b !== null) return { kind: 'roll', boundarySlot: b };
  const floor = last.slot > lastRolledBoundary ? last.slot : lastRolledBoundary;
  const from = floor > v.currentSlot ? floor : v.currentSlot;
  return { kind: 'wait', nextBoundary: v.interval > 0n ? nextBoundary(from, v.interval) : null };
}
