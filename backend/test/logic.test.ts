import { address } from '@solana/kit';
import {
  ATTESTED,
  CHAIN_OK,
  NOT_RECAPTURE,
  NOT_REUSED,
  PEOPLE_OK,
  WORDS_OK,
  linkPasses,
  type SlotHashEntry,
} from '@chalk/shared';
import { describe, expect, it } from 'vitest';
import { latestRollableBoundary, nextBoundary, planRoll, type DayLike } from '../src/boundary.ts';
import { defaultConfigArgs, parseUsdc } from '../src/defaults.ts';
import { flagsFromVision, type VisionResult } from '../src/flags.ts';

const good: VisionResult = {
  words_ok: true,
  chain_ok: true,
  headcount: 7,
  is_recapture: false,
  reuse: { is_reuse: false, distance: 118, match_id: null, exact_duplicate: false },
};

describe('flagsFromVision', () => {
  it('all checks pass', () => {
    const f = flagsFromVision(good, 3, 1);
    expect(f).toBe(WORDS_OK | CHAIN_OK | NOT_RECAPTURE | NOT_REUSED | PEOPLE_OK);
    expect(linkPasses(f | ATTESTED)).toBe(true);
    expect(linkPasses(f)).toBe(false);
  });

  it('each failing check clears only its bit', () => {
    const all = flagsFromVision(good, 3, 1);
    expect(flagsFromVision({ ...good, words_ok: false }, 3, 1)).toBe(all & ~WORDS_OK);
    expect(flagsFromVision({ ...good, chain_ok: false }, 3, 1)).toBe(all & ~CHAIN_OK);
    expect(flagsFromVision({ ...good, is_recapture: true }, 3, 1)).toBe(all & ~NOT_RECAPTURE);
    expect(flagsFromVision({ ...good, reuse: { is_reuse: true } }, 3, 1)).toBe(all & ~NOT_REUSED);
    expect(flagsFromVision({ ...good, headcount: 2 }, 3, 1)).toBe(all & ~PEOPLE_OK);
  });

  it('headcount equal to the minimum passes', () => {
    expect(flagsFromVision({ ...good, headcount: 3 }, 3, 1) & PEOPLE_OK).toBe(PEOPLE_OK);
  });

  it('fails closed on missing fields', () => {
    const f = flagsFromVision({ words_ok: true } as unknown as VisionResult, 0, 1);
    expect(f).toBe(WORDS_OK);
  });

  it('CHAIN_OK is vacuous for link 0', () => {
    expect(flagsFromVision({ ...good, chain_ok: false }, 3, 0) & CHAIN_OK).toBe(CHAIN_OK);
  });
});

function hashes(from: bigint, to: bigint, skip: bigint[] = []): SlotHashEntry[] {
  const out: SlotHashEntry[] = [];
  for (let s = to; s >= from; s--) if (!skip.includes(s)) out.push({ slot: s, hash: new Uint8Array(32) });
  return out;
}

describe('latestRollableBoundary', () => {
  const base = { currentSlot: 1234n, interval: 100n, lastLinkSlot: 1000n, lastRolledBoundary: 0n };

  it('picks floor(current / interval) * interval', () => {
    expect(latestRollableBoundary({ ...base, slotHashes: hashes(800n, 1234n) })).toBe(1200n);
  });

  it('a boundary exactly at the current slot counts', () => {
    expect(latestRollableBoundary({ ...base, currentSlot: 1300n, slotHashes: hashes(800n, 1300n) })).toBe(1300n);
  });

  it('steps back when the boundary slot was skipped', () => {
    expect(latestRollableBoundary({ ...base, slotHashes: hashes(800n, 1234n, [1200n]) })).toBe(1100n);
  });

  it('must be after the last link and the last rolled boundary', () => {
    const sh = hashes(800n, 1234n);
    expect(latestRollableBoundary({ ...base, lastRolledBoundary: 1200n, slotHashes: sh })).toBeNull();
    expect(latestRollableBoundary({ ...base, lastLinkSlot: 1200n, slotHashes: sh })).toBeNull();
    expect(latestRollableBoundary({ ...base, lastLinkSlot: 1199n, slotHashes: sh })).toBe(1200n);
    expect(latestRollableBoundary({ ...base, lastRolledBoundary: 1100n, slotHashes: hashes(800n, 1234n, [1200n]) })).toBeNull();
  });

  it('boundary must still be in SlotHashes', () => {
    expect(latestRollableBoundary({ ...base, slotHashes: hashes(1201n, 1234n) })).toBeNull();
    expect(latestRollableBoundary({ ...base, slotHashes: [] })).toBeNull();
  });

  it('nextBoundary', () => {
    expect(nextBoundary(1234n, 100n)).toBe(1300n);
    expect(nextBoundary(1200n, 100n)).toBe(1300n);
  });
});

describe('planRoll', () => {
  const view = { currentSlot: 1234n, interval: 100n, slotHashes: hashes(800n, 1234n) };
  const day = (over: Partial<DayLike> = {}): DayLike => ({
    settled: false,
    recheckPending: false,
    nLinks: 1,
    lastRolledBoundary: 0n,
    links: [{ slot: 1000n }],
    ...over,
  });

  it('roll at the newest boundary, or why not', () => {
    expect(planRoll(day(), view)).toEqual({ kind: 'roll', boundarySlot: 1200n });
    expect(planRoll(null, view)).toEqual({ kind: 'missing' });
    expect(planRoll(day({ nLinks: 0, links: [] }), view)).toEqual({ kind: 'missing' });
    expect(planRoll(day({ settled: true }), view)).toEqual({ kind: 'settled' });
    expect(planRoll(day({ recheckPending: true }), view)).toEqual({ kind: 'pending' });
  });

  it('wait reports the next boundary after the last link / last roll / now', () => {
    expect(planRoll(day({ links: [{ slot: 1210n }] }), view)).toEqual({ kind: 'wait', nextBoundary: 1300n });
    expect(planRoll(day({ lastRolledBoundary: 1200n }), view)).toEqual({ kind: 'wait', nextBoundary: 1300n });
    expect(planRoll(day({ links: [{ slot: 1310n }] }), view)).toEqual({ kind: 'wait', nextBoundary: 1400n });
    expect(planRoll(day(), { ...view, interval: 0n })).toEqual({ kind: 'wait', nextBoundary: null });
  });

  it('rolledFloor stands in for a roll the chain does not show yet', () => {
    expect(planRoll(day(), view, 1200n)).toEqual({ kind: 'wait', nextBoundary: 1300n });
    expect(planRoll(day(), view, 1100n)).toEqual({ kind: 'roll', boundarySlot: 1200n });
  });
});

describe('admin defaults', () => {
  it('parseUsdc', () => {
    expect(parseUsdc('100')).toBe(100_000_000n);
    expect(parseUsdc('12.5')).toBe(12_500_000n);
    expect(parseUsdc('0.000001')).toBe(1n);
    expect(() => parseUsdc('1.0000001')).toThrow();
    expect(() => parseUsdc('-1')).toThrow();
  });

  it('defaultConfigArgs at 400 ms slots', () => {
    const a = defaultConfigArgs(address('11111111111111111111111111111111'), 400);
    expect(a).toMatchObject({
      windowSlots: 225n,
      recheckWindowSlots: 450n,
      recheckIntervalSlots: 300n,
      bonusPerLink: 600_000n,
      recheckThreshold: 64,
      maxLinks: 6,
      minHeadcount: 3,
    });
  });
});
