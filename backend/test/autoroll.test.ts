import { address, type Address } from '@solana/kit';
import type { SlotHashEntry } from '@chalk/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutoRoller, type AutoRollView, type RollResult } from '../src/autoroll.ts';
import type { DayLike } from '../src/boundary.ts';

const A = address('11111111111111111111111111111111');
const B = address('SysvarS1otHashes111111111111111111111111111');
const TODAY = 20715;

function hashes(from: bigint, to: bigint, skip: bigint[] = []): SlotHashEntry[] {
  const out: SlotHashEntry[] = [];
  for (let s = to; s >= from; s--) if (!skip.includes(s)) out.push({ slot: s, hash: new Uint8Array(32) });
  return out;
}

const openDay = (over: Partial<DayLike> = {}): DayLike => ({
  settled: false,
  recheckPending: false,
  nLinks: 1,
  lastRolledBoundary: 0n,
  links: [{ slot: 1000n }],
  ...over,
});

/** Fake chain: the tests move the slot and edit days; rolls are recorded, not applied (a lagging RPC). */
function fake() {
  const chain = {
    view: { currentSlot: 1234n, interval: 100n, maxLinks: 6, slotHashes: hashes(800n, 1234n) } as AutoRollView,
    days: new Map<string, DayLike>(),
    rolls: [] as { teacher: Address; day: number; boundarySlot: bigint }[],
    hit: true as boolean | null,
    failRoll: null as Error | null,
    today: TODAY,
    logs: [] as string[],
  };
  const setView = (currentSlot: bigint) => {
    chain.view = { ...chain.view, currentSlot, slotHashes: hashes(currentSlot - 400n, currentSlot) };
  };
  const make = (enabled = true, openDays?: () => Promise<{ teacher: typeof A; day: number }[]>) =>
    new AutoRoller(
      {
        view: async () => chain.view,
        ...(openDays ? { openDays } : {}),
        getDay: async (t, d) => chain.days.get(`${t}:${d}`) ?? null,
        roll: async (teacher, day, boundarySlot): Promise<RollResult> => {
          if (chain.failRoll) throw chain.failRoll;
          chain.rolls.push({ teacher, day, boundarySlot });
          return { signature: `sig${chain.rolls.length}`, boundarySlot, hit: chain.hit, roll: 7 };
        },
        today: () => chain.today,
        log: (l) => chain.logs.push(l),
      },
      { enabled, intervalMs: 1000 },
    );
  return { chain, setView, make };
}

describe('AutoRoller', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('disabled: watch is refused and nothing is tracked', async () => {
    const { make } = fake();
    const r = make(false);
    expect(r.watch(A, TODAY)).toBe(false);
    expect(r.status()).toMatchObject({ enabled: false, active: 0, lastRoll: null });
  });

  it('rolls at the newest eligible boundary and records lastRoll', async () => {
    const { chain, make } = fake();
    chain.days.set(`${A}:${TODAY}`, openDay());
    const r = make();
    expect(r.watch(A, TODAY)).toBe(true);
    await r.tick();
    expect(chain.rolls).toEqual([{ teacher: A, day: TODAY, boundarySlot: 1200n }]);
    expect(r.status().lastRoll).toMatchObject({ teacher: A, day: TODAY, boundarySlot: '1200', hit: true, roll: 7, signature: 'sig1' });
    expect(chain.logs.at(-1)).toMatch(/boundary 1200 roll 7: HIT/);
  });

  it('steps back over a skipped boundary slot', async () => {
    const { chain, make } = fake();
    chain.view = { ...chain.view, slotHashes: hashes(800n, 1234n, [1200n]) };
    chain.days.set(`${A}:${TODAY}`, openDay());
    const r = make();
    r.watch(A, TODAY);
    await r.tick();
    expect(chain.rolls.map((x) => x.boundarySlot)).toEqual([1100n]);
  });

  it('never rolls the same boundary twice, even when the chain read lags', async () => {
    const { chain, setView, make } = fake();
    chain.hit = false;
    chain.days.set(`${A}:${TODAY}`, openDay());
    const r = make();
    r.watch(A, TODAY);
    await r.tick();
    await r.tick();
    setView(1299n);
    await r.tick();
    expect(chain.rolls.map((x) => x.boundarySlot)).toEqual([1200n]);
    expect(chain.logs.at(-1)).toMatch(/: miss/);
    setView(1300n);
    await r.tick();
    expect(chain.rolls.map((x) => x.boundarySlot)).toEqual([1200n, 1300n]);
  });

  it('respects the on-chain last_rolled_boundary and the last link slot', async () => {
    const { chain, make } = fake();
    chain.days.set(`${A}:${TODAY}`, openDay({ lastRolledBoundary: 1200n }));
    chain.days.set(`${B}:${TODAY}`, openDay({ nLinks: 2, links: [{ slot: 1000n }, { slot: 1210n }] }));
    const r = make();
    r.watch(A, TODAY);
    r.watch(B, TODAY);
    await r.tick();
    expect(chain.rolls).toEqual([]);
    expect(r.active).toBe(2);
  });

  it('skips a day with a pending re-check but keeps watching it', async () => {
    const { chain, make } = fake();
    const key = `${A}:${TODAY}`;
    chain.days.set(key, openDay({ recheckPending: true }));
    const r = make();
    r.watch(A, TODAY);
    await r.tick();
    expect(chain.rolls).toEqual([]);
    expect(r.active).toBe(1);
    chain.days.set(key, openDay({ nLinks: 2, links: [{ slot: 1000n }, { slot: 1100n }] }));
    await r.tick();
    expect(chain.rolls.map((x) => x.boundarySlot)).toEqual([1200n]);
  });

  it('drops settled days, full chains and days older than yesterday', async () => {
    const { chain, make } = fake();
    const full = Array.from({ length: 6 }, (_, i) => ({ slot: 100n + BigInt(i) }));
    chain.days.set(`${A}:${TODAY}`, openDay({ settled: true }));
    chain.days.set(`${B}:${TODAY}`, openDay({ nLinks: 6, links: full }));
    chain.days.set(`${A}:${TODAY - 1}`, openDay());
    chain.days.set(`${A}:${TODAY - 2}`, openDay());
    const r = make();
    for (const [t, d] of [[A, TODAY], [B, TODAY], [A, TODAY - 1], [A, TODAY - 2]] as const) r.watch(t, d);
    expect(r.active).toBe(4);
    await r.tick();
    expect(chain.rolls).toEqual([{ teacher: A, day: TODAY - 1, boundarySlot: 1200n }]);
    expect(r.active).toBe(1);
    chain.today = TODAY + 1;
    await r.tick();
    expect(r.active).toBe(0);
  });

  it('keeps a watched day with no Day account yet', async () => {
    const { chain, make } = fake();
    const r = make();
    r.watch(A, TODAY);
    await r.tick();
    expect(r.active).toBe(1);
    chain.days.set(`${A}:${TODAY}`, openDay());
    await r.tick();
    expect(chain.rolls).toHaveLength(1);
  });

  it('a failed roll is logged once and does not block other days or retry that boundary', async () => {
    const { chain, make } = fake();
    chain.days.set(`${A}:${TODAY}`, openDay());
    const r = make();
    r.watch(A, TODAY);
    chain.failRoll = new Error('rpc down');
    await r.tick();
    await r.tick();
    expect(chain.logs.filter((l) => l.includes('rpc down'))).toHaveLength(1);
    chain.failRoll = null;
    await r.tick();
    expect(chain.rolls).toEqual([]);
    chain.days.set(`${B}:${TODAY}`, openDay());
    r.watch(B, TODAY);
    await r.tick();
    expect(chain.rolls.map((x) => x.teacher)).toEqual([B]);
  });

  it('overlapping ticks share one pass; start() ticks on the interval', async () => {
    vi.useFakeTimers();
    const { chain, make } = fake();
    chain.days.set(`${A}:${TODAY}`, openDay());
    const r = make();
    r.watch(A, TODAY);
    await Promise.all([r.tick(), r.tick()]);
    expect(chain.rolls).toHaveLength(1);

    chain.days.set(`${B}:${TODAY}`, openDay());
    r.watch(B, TODAY);
    r.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(chain.rolls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(chain.rolls).toHaveLength(2);
    r.stop();
  });
});

describe('AutoRoller re-arming after a restart', () => {
  it('watches the open days the chain reports when it starts', async () => {
    const { chain, make } = fake();
    const roller = make(true, async () => [{ teacher: A, day: chain.today }]);
    expect(roller.active).toBe(0);
    roller.start();
    await vi.waitFor(() => expect(roller.active).toBe(1));
    roller.stop();
    expect(chain.logs.join(' ')).toContain('re-armed');
  });

  it('keeps running when the chain cannot be read', async () => {
    const { chain, make } = fake();
    const roller = make(true, async () => {
      throw new Error('rpc down');
    });
    roller.start();
    await vi.waitFor(() => expect(chain.logs.join(' ')).toContain('could not re-arm'));
    expect(roller.status().enabled).toBe(true);
    roller.stop();
  });
});
