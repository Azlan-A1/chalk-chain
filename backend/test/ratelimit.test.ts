import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { DEFAULT_LIMITS, TOO_MANY, TokenBuckets, rateLimit } from '../src/ratelimit.ts';

beforeEach(() => {
  delete process.env.CHALK_TRUST_PROXY;
});
afterEach(() => {
  delete process.env.CHALK_TRUST_PROXY;
});

function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t };
  return c;
}

describe('TokenBuckets', () => {
  it('allows a full minute as a burst, then refills continuously', () => {
    const c = clock();
    const b = new TokenBuckets(c.now);
    for (let i = 0; i < 10; i++) expect(b.take('k', 10)).toBe(0);
    expect(b.take('k', 10)).toBe(6000);
    c.t += 5999;
    expect(b.take('k', 10)).toBe(1);
    c.t += 1;
    expect(b.take('k', 10)).toBe(0);
    expect(b.take('k', 10)).toBe(6000);
  });

  it('never refills past capacity', () => {
    const c = clock();
    const b = new TokenBuckets(c.now);
    b.take('k', 3);
    c.t += 3_600_000;
    for (let i = 0; i < 3; i++) expect(b.take('k', 3)).toBe(0);
    expect(b.take('k', 3)).toBeGreaterThan(0);
  });

  it('keys are independent', () => {
    const b = new TokenBuckets(clock().now);
    expect(b.take('a', 1)).toBe(0);
    expect(b.take('a', 1)).toBeGreaterThan(0);
    expect(b.take('b', 1)).toBe(0);
  });
});

describe('rateLimit middleware', () => {
  function app(limits = { '/relay': 2 }) {
    const c = clock();
    const a = new Hono();
    a.use('*', cors());
    a.use('*', rateLimit(limits, new TokenBuckets(c.now)));
    a.post('/relay', (x) => x.json({ ok: true }));
    a.post('/other', (x) => x.json({ ok: true }));
    a.get('/relay', (x) => x.json({ ok: true }));
    return { a, c };
  }
  const post = (a: Hono, path: string, ip = '10.0.0.1') =>
    a.request(path, { method: 'POST', headers: { 'x-forwarded-for': ip, origin: 'http://localhost:5173' } });

  it('429 with the friendly message, Retry-After and CORS once the bucket is empty', async () => {
    const { a, c } = app();
    expect((await post(a, '/relay')).status).toBe(200);
    expect((await post(a, '/relay')).status).toBe(200);
    const res = await post(a, '/relay');
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: TOO_MANY, code: null, message: TOO_MANY });
    expect(res.headers.get('retry-after')).toBe('30');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    c.t += 30_000;
    expect((await post(a, '/relay')).status).toBe(200);
  });

  it('per IP behind a declared proxy; GETs and unlisted routes are not limited', async () => {
    process.env.CHALK_TRUST_PROXY = '1';
    const { a } = app({ '/relay': 1 });
    expect((await post(a, '/relay', '10.0.0.1')).status).toBe(200);
    expect((await post(a, '/relay', '10.0.0.1')).status).toBe(429);
    expect((await post(a, '/relay', '10.0.0.2')).status).toBe(200);
    for (let i = 0; i < 5; i++) {
      expect((await a.request('/relay')).status).toBe(200);
      expect((await post(a, '/other')).status).toBe(200);
    }
  });

  it('ignores a spoofed forwarding header unless CHALK_TRUST_PROXY=1', async () => {
    delete process.env.CHALK_TRUST_PROXY;
    const { a } = app({ '/relay': 1 });
    expect((await post(a, '/relay', '10.0.0.1')).status).toBe(200);
    // A fresh header would be a fresh bucket if we trusted it; we do not, so this is the same client.
    expect((await post(a, '/relay', '10.0.0.2')).status).toBe(429);
  });

  it('uses the last forwarding entry, the one the proxy appended', async () => {
    process.env.CHALK_TRUST_PROXY = '1';
    const { a } = app({ '/relay': 1 });
    const two = (spoof: string) =>
      a.request('/relay', { method: 'POST', headers: { 'x-forwarded-for': `${spoof}, 10.0.0.9` } });
    expect((await two('1.2.3.4')).status).toBe(200);
    expect((await two('5.6.7.8')).status).toBe(429); // same real client, different spoofed prefix
  });

  it('createApp applies the defaults before touching the chain, and can be disabled', async () => {
    process.env.CHALK_TRUST_PROXY = '1';
    const dir = tmpdir();
    const paths = { deploy: join(dir, 'chalk-missing-deploy.json'), keys: join(dir, 'chalk-missing-keys') };
    const limited = createApp({ paths });
    const req = () => limited.request('/settle', { method: 'POST', headers: { 'x-forwarded-for': '10.9.9.9' } });
    for (let i = 0; i < DEFAULT_LIMITS['/settle']!; i++) expect((await req()).status).toBe(503);
    expect((await req()).status).toBe(429);

    const open = createApp({ paths, rateLimit: false });
    for (let i = 0; i < 15; i++) {
      expect((await open.request('/settle', { method: 'POST', headers: { 'x-forwarded-for': '10.9.9.9' } })).status).toBe(503);
    }
  });
});
