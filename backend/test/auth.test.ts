import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';

const paths = { deploy: join(tmpdir(), 'chalk-auth-deploy.json'), keys: join(tmpdir(), 'chalk-auth-keys') };
const body = JSON.stringify({ teacher: 'Ev8Lh3UtSJsZWur1FG2awUkUmMHufSx57mpgzGnDNtJp', day: 20715 });

describe('oracle routes behind CHALK_ADMIN_TOKEN', () => {
  beforeEach(() => {
    process.env.CHALK_ADMIN_TOKEN = 'secret-token';
  });
  afterEach(() => {
    delete process.env.CHALK_ADMIN_TOKEN;
  });

  const post = (app: ReturnType<typeof createApp>, path: string, auth?: string) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
      body,
    });

  it('refuses /recheck, /roll, /settle and /watch without the token', async () => {
    const app = createApp({ paths, rateLimit: false });
    for (const path of ['/recheck', '/roll', '/settle', '/watch']) {
      expect((await post(app, path)).status, path).toBe(401);
      expect((await post(app, path, 'Bearer wrong')).status, path).toBe(401);
    }
  });

  it('lets the token through (503 here only because this test has no chain)', async () => {
    const app = createApp({ paths, rateLimit: false });
    const res = await post(app, '/settle', 'Bearer secret-token');
    expect(res.status).not.toBe(401);
  });

  it('is open when no token is configured', async () => {
    delete process.env.CHALK_ADMIN_TOKEN;
    const app = createApp({ paths, rateLimit: false });
    expect((await post(app, '/settle')).status).not.toBe(401);
  });
});
