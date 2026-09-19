import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

// Per-IP token buckets for the POST routes. Each bucket holds up to `perMinute` tokens and refills
// continuously, so a client can burst a full minute's worth and then keeps the average rate.

export type Limits = Readonly<Record<string, number>>;

// /roll is higher than the other oracle routes because scripts/e2e.ts polls it every 0.5 s
// until a boundary slot passes (a 409 there costs no fee).
export const DEFAULT_LIMITS: Limits = {
  '/relay': 30,
  '/verify': 20,
  '/recheck': 10,
  '/roll': 60,
  '/settle': 10,
  '/watch': 10,
};

export const TOO_MANY = 'Too many requests — wait a moment and try again.';

const MAX_BUCKETS = 10_000;

interface Bucket {
  tokens: number;
  at: number;
  capacity: number;
}

export class TokenBuckets {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Takes a token from `key`'s bucket. Returns 0 on success, else ms until the next token. */
  take(key: string, perMinute: number): number {
    const t = this.now();
    const rate = perMinute / 60_000;
    const b = this.buckets.get(key);
    const tokens = b ? Math.min(perMinute, b.tokens + (t - b.at) * rate) : perMinute;
    if (!b && this.buckets.size >= MAX_BUCKETS) this.sweep(t);
    if (tokens >= 1) {
      this.buckets.set(key, { tokens: tokens - 1, at: t, capacity: perMinute });
      return 0;
    }
    this.buckets.set(key, { tokens, at: t, capacity: perMinute });
    return Math.ceil((1 - tokens) / rate);
  }

  get size(): number {
    return this.buckets.size;
  }

  /** Forgets buckets that have refilled completely (they behave exactly like new ones). */
  private sweep(t: number) {
    for (const [k, b] of this.buckets) {
      if (b.tokens + ((t - b.at) * b.capacity) / 60_000 >= b.capacity) this.buckets.delete(k);
    }
  }
}

const isLoopback = (a: string) => a === '::1' || a.startsWith('127.') || a.startsWith('::ffff:127.');

/** Socket peer address; X-Forwarded-For is trusted only from a local proxy (the Vite dev server). */
export function clientIp(c: Context): string {
  let peer = '';
  try {
    peer = getConnInfo(c).remote.address ?? '';
  } catch {
    // not running under @hono/node-server (tests)
  }
  // Only behind a proxy we were told about, and then the LAST entry: the one the proxy appended.
  // Anything earlier is attacker-supplied, which would let one client spoof unlimited buckets.
  if (process.env.CHALK_TRUST_PROXY === '1' && (!peer || isLoopback(peer))) {
    const chain = c.req.header('x-forwarded-for')?.split(',') ?? [];
    const fwd = chain.at(-1)?.trim();
    if (fwd) return fwd;
  }
  return peer || 'unknown';
}

export function rateLimit(limits: Limits, buckets = new TokenBuckets(), ipOf: (c: Context) => string = clientIp): MiddlewareHandler {
  return async (c, next) => {
    const perMinute = c.req.method === 'POST' ? limits[c.req.path] : undefined;
    if (perMinute) {
      const waitMs = buckets.take(`${c.req.path} ${ipOf(c)}`, perMinute);
      if (waitMs > 0) {
        c.header('Retry-After', String(Math.ceil(waitMs / 1000)));
        return c.json({ error: TOO_MANY, code: null, message: TOO_MANY }, 429);
      }
    }
    await next();
  };
}
