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
