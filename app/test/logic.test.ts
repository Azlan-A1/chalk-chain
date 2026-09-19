import {
  bytesToAddress,
  dayFromJson,
  dayToJson,
  decodeDay,
  encodeDay,
  fromHex,
  PASS_MASK,
  type DayAccount,
  type DayJson,
  type WordTriple,
} from '@chalk/shared';
import { describe, expect, it } from 'vitest';
import vectors from '../../shared/vectors/derivation.json' with { type: 'json' };
import type { VerifyResult } from '../src/api.ts';
import {
  checkRows,
  checksPass,
  formatCountdown,
  formatUsdc,
  nextLink,
  sealedSeconds,
  slotsMsLeft,
  windowMsLeft,
  wordsForNext,
} from '../src/logic.ts';

describe('countdown math', () => {
  it('window left = (window_slots - slot age) * slotMs, minus local elapsed', () => {
    const p = { windowSlots: 225, slot: 1000, currentSlot: 1010, slotMs: 400 };
    expect(windowMsLeft(p)).toBe(215 * 400);
    expect(windowMsLeft(p, 6000)).toBe(215 * 400 - 6000);
    expect(windowMsLeft({ ...p, currentSlot: 1300 })).toBe(0);
    expect(windowMsLeft(p, 1e9)).toBe(0);
    // A confirmed slot can be ahead of a lagging currentSlot: never more than the full window.
    expect(windowMsLeft({ ...p, currentSlot: 990 })).toBe(225 * 400);
  });

  it('re-check deadline and sealed seconds', () => {
    expect(slotsMsLeft(2000, 1900, 400)).toBe(40_000);
    expect(slotsMsLeft(2000, 1900, 400, 10_000)).toBe(30_000);
    expect(slotsMsLeft(2000, 2100, 400)).toBe(0);
    expect(sealedSeconds(30, 400)).toBe(12);
    expect(formatCountdown(90_000)).toBe('1:30');
    expect(formatCountdown(4_001)).toBe('0:05');
    expect(formatCountdown(0)).toBe('0:00');
  });

  it('formats USDC base units', () => {
    expect(formatUsdc(250_000n)).toBe('0.25');
    expect(formatUsdc('1500000')).toBe('1.50');
    expect(formatUsdc(2_000_000)).toBe('2');
    expect(formatUsdc(1_234_567n)).toBe('1.234567');
  });
});

type Vec = (typeof vectors.cases)[number];

/** A Day as the backend would serve it after `n` links, round-tripped through the JSON wire shape. */
function dayAfter(c: Vec, n: number, recheckPending: boolean): DayAccount {
  const teacher = bytesToAddress(fromHex(c.teacher));
  const bytes = encodeDay({
    teacher,
    day: c.day,
    nLinks: n,
    recheckPending,
    rechecksMet: Math.max(0, n - 1),
    missedRecheck: false,
    settled: false,
    bump: 254,
    recheckFromSlot: 0n,
    recheckDeadlineSlot: 0n,
    lastRolledBoundary: 0n,
    paid: 0n,
    links: c.links.slice(0, n).map((l, i) => ({
      slot: BigInt(100 + i),
      photoHash: fromHex(l.photo_hash),
      seed: fromHex(l.seed),
      commit: fromHex(l.commit),
      words: l.words as WordTriple,
      flags: PASS_MASK,
      headcount: 9,
    })),
  });
  const wire = JSON.parse(JSON.stringify(dayToJson(decodeDay(bytes), 'en'))) as DayJson;
  return dayFromJson(wire);
}

describe('word derivation wiring', () => {
  it('link 0 chains from prev_0 when there is no Day yet', () => {
    for (const c of vectors.cases) {
      const wallet = bytesToAddress(fromHex(c.teacher));
      const l0 = c.links[0]!;
      const w = wordsForNext(wallet, c.day, null, l0.slot_hash, 'en');
      expect(w).toMatchObject({ idx: 0, kind: 'check_in', words: l0.words_en, prior: [] });
    }
  });

  it('link k chains from links[k-1].commit of the Day served by GET /day', () => {
    for (const c of vectors.cases) {
      const wallet = bytesToAddress(fromHex(c.teacher));
      for (let k = 1; k < c.links.length; k++) {
        const day = dayAfter(c, k, true);
        const lk = c.links[k]!;
        const w = wordsForNext(wallet, c.day, day, lk.slot_hash, 'sw');
        expect(w?.idx).toBe(k);
        expect(w?.kind).toBe('recheck_in');
        expect(w?.words).toEqual(lk.words_sw);
        expect(w?.prior).toEqual(c.links.slice(0, k).map((l) => l.words_sw));
      }
    }
  });

  it('nothing to answer without an open re-check, when settled, or when full', () => {
    const c = vectors.cases[0]!;
    const wallet = bytesToAddress(fromHex(c.teacher));
    expect(wordsForNext(wallet, c.day, dayAfter(c, 1, false), c.links[1]!.slot_hash, 'en')).toBeNull();
    expect(nextLink({ ...dayAfter(c, 1, true), settled: true })).toBeNull();
    expect(nextLink(dayAfter(c, 2, true), 2)).toBeNull();
    expect(nextLink({ ...dayAfter(c, 1, false), nLinks: 0, links: [] })).toEqual({ idx: 0, kind: 'check_in' });
  });
});

describe('check rows', () => {
  const base: VerifyResult = {
    words_ok: true,
    words_found: [true, true, false],
    chain_ok: true,
    prior_found: [],
    decoys_flagged: [],
    headcount: 7,
    is_recapture: false,
    recapture_score: 0.1,
    reuse: { is_reuse: false, distance: 100, match_id: null, exact_duplicate: false },
    reasons: [],
    engine: 'mock',
    ms: 1,
    flags: 0x1f & ~4,
  };

  it('uses the attested flags and hides "Earlier words" on link 0', () => {
    const rows0 = checkRows(base, 0);
    expect(rows0.map((r) => r.key)).toEqual(['words', 'people', 'real', 'new']);
    expect(rows0.find((r) => r.key === 'real')?.ok).toBe(false);
    expect(rows0.find((r) => r.key === 'people')?.label).toBe('People (7)');
    expect(checkRows(base, 2).map((r) => r.key)).toEqual(['words', 'chain', 'people', 'real', 'new']);
    expect(checksPass(base.flags)).toBe(false);
    expect(checksPass(0x1f)).toBe(true);
    expect(checksPass(PASS_MASK)).toBe(true);
  });
});
