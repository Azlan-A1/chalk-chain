import type { Address } from '@solana/kit';
import { dayNumber } from '@chalk/shared';
import { planRoll, type DayLike, type RollView } from './boundary.ts';

// Opt-in cranker (CHALK_AUTO_ROLL=1): every tick, rolls roll_recheck at the newest eligible boundary
// for each open day it knows about. Days are added when /relay lands a check-in or via POST /watch.

export interface AutoRollView extends RollView {
  /** min(config.max_links, MAX_LINKS): a full chain can't take a re-check, so rolling it is wasted fees. */
  maxLinks: number;
}

export interface RollResult {
  signature: string;
  boundarySlot: bigint;
  hit: boolean | null;
  roll: number | null;
}

export interface AutoRollDeps {
  view(): Promise<AutoRollView>;
  getDay(teacher: Address, day: number): Promise<DayLike | null>;
  roll(teacher: Address, day: number, boundarySlot: bigint): Promise<RollResult>;
  today?: () => number;
  log?: (line: string) => void;
}

export interface LastRoll {
  teacher: Address;
  day: number;
  boundarySlot: string;
  hit: boolean | null;
  roll: number | null;
  signature: string;
  at: string;
}

interface Watched {
  teacher: Address;
  day: number;
  /** Newest boundary this process sent a roll for, so a lagging read can't make us roll it twice. */
  rolled: bigint;
}

export const MAX_WATCHED = 1000;

export class AutoRoller {
  readonly enabled: boolean;
  readonly intervalMs: number;
  lastRoll: LastRoll | null = null;
  private readonly deps: AutoRollDeps;
  private readonly watched = new Map<string, Watched>();
  private readonly lastError = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;

  constructor(deps: AutoRollDeps, opts: { enabled: boolean; intervalMs?: number }) {
    this.deps = deps;
    this.enabled = opts.enabled;
    this.intervalMs = opts.intervalMs ?? 3000;
  }

  /** Adds (teacher, day). False when disabled or full. */
  watch(teacher: Address, day: number): boolean {
    if (!this.enabled) return false;
    const key = `${teacher}:${day}`;
    if (this.watched.has(key)) return true;
    if (this.watched.size >= MAX_WATCHED) return false;
    this.watched.set(key, { teacher, day, rolled: 0n });
    return true;
  }

  get active(): number {
    return this.watched.size;
  }

  status() {
    return { enabled: this.enabled, intervalMs: this.intervalMs, active: this.watched.size, lastRoll: this.lastRoll };
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass over the watched days. Overlapping calls share the pass in progress. */
  tick(): Promise<void> {
    this.running ??= this.pass().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private log(line: string) {
    (this.deps.log ?? console.log)(line);
  }

  private fail(key: string, err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (this.lastError.get(key) === msg) return;
    this.lastError.set(key, msg);
    this.log(`auto-roll ${key}: ${msg}`);
  }

  private async pass(): Promise<void> {
    const today = (this.deps.today ?? dayNumber)();
    for (const [key, w] of this.watched) {
      if (w.day + 1 < today) this.forget(key);
    }
    if (this.watched.size === 0) return;

    let view: AutoRollView;
    try {
      view = await this.deps.view();
      this.lastError.delete('chain');
    } catch (e) {
      return this.fail('chain', e);
    }

    for (const [key, w] of [...this.watched]) {
      try {
        const day = await this.deps.getDay(w.teacher, w.day);
        if (!day) continue;
        if (day.settled || day.nLinks >= view.maxLinks) {
          this.forget(key);
          continue;
        }
        const plan = planRoll(day, view, w.rolled);
        if (plan.kind !== 'roll') continue;
        w.rolled = plan.boundarySlot;
        const r = await this.deps.roll(w.teacher, w.day, plan.boundarySlot);
        this.lastRoll = {
          teacher: w.teacher,
          day: w.day,
          boundarySlot: r.boundarySlot.toString(),
          hit: r.hit,
          roll: r.roll,
          signature: r.signature,
          at: new Date().toISOString(),
        };
        this.lastError.delete(key);
        const outcome = r.hit ? 'HIT, re-check open' : r.hit === false ? 'miss' : 'sent';
        this.log(`auto-roll ${key} boundary ${r.boundarySlot} roll ${r.roll ?? '?'}: ${outcome} (${r.signature})`);
      } catch (e) {
        this.fail(key, e);
      }
    }
  }

  /** Stop watching (teacher, day) — call before settling so no roll lands mid-settle. */
  forgetDay(teacher: string, day: number) {
    this.forget(`${teacher}:${day}`);
  }

  /** Stop watching a day: it is being settled, or it is over. */
  forget(key: string) {
    this.watched.delete(key);
    this.lastError.delete(key);
  }
}
