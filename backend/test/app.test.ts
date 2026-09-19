import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendTransactionMessageInstruction,
  blockhash,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type Address,
} from '@solana/kit';
import {
  SYSVAR_SLOT_HASHES_ADDRESS,
  addressBytes,
  encodeConfig,
  encodeDay,
  encodeSlotHashes,
  findConfigPda,
  findDayPda,
  fromBase64,
  getCheckInInstruction,
  identifyInstruction,
  dayNumber,
  photoHash,
  toBase64,
  toHex,
  type DayJson,
} from '@chalk/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';

function firstIx(messageBytes: Uint8Array) {
  const msg = getCompiledTransactionMessageDecoder().decode(messageBytes);
  if (msg.version === 1) throw new Error('unexpected v1');
  const ix = msg.instructions[0]!;
  return { program: msg.staticAccounts[ix.programAddressIndex], data: new Uint8Array(ix.data ?? []) };
}

const tmp = () => mkdtempSync(join(tmpdir(), 'chalk-backend-'));

async function writeKeys(dir: string) {
  for (const name of ['admin', 'relayer', 'oracle']) {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const { createKeyPairSignerFromPrivateKeyBytes } = await import('@solana/kit');
    const s = await createKeyPairSignerFromPrivateKeyBytes(seed);
    writeFileSync(join(dir, `${name}.json`), JSON.stringify([...seed, ...addressBytes(s.address)]));
  }
}

describe('server without setup', () => {
  const dir = tmp();
  const app = createApp({ paths: { deploy: join(dir, 'missing.json'), keys: join(dir, 'keys') } });

  it('GET /health answers 503 with a clear message instead of crashing', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/missing\.json not found/);
    expect(body.error).toMatch(/admin keygen/);
  });

  it('chain routes answer 503 too, with CORS', async () => {
    for (const [method, path] of [
      ['GET', '/slot'],
      ['GET', '/config'],
      ['POST', '/relay'],
    ] as const) {
      const res = await app.request(path, { method, headers: { origin: 'http://localhost:5173' } });
      expect(res.status, path).toBe(503);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    }
  });

  it('missing keys are reported', async () => {
    const d = tmp();
    writeFileSync(join(d, 'deploy.json'), JSON.stringify({ cluster: 'localnet', programId: '11111111111111111111111111111111' }));
    const res = await createApp({ paths: { deploy: join(d, 'deploy.json'), keys: join(d, 'nokeys') } }).request('/health');
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/relayer\.json not found|oracle\.json not found/);
  });
});

const VISION_SAMPLE = {
  words_ok: true,
  words_found: [true, true, true],
  chain_ok: true,
  prior_found: [],
  decoys_flagged: [],
  headcount: 7,
  is_recapture: false,
  recapture_score: 0.12,
  reuse: { is_reuse: false, distance: 118, match_id: null, exact_duplicate: false },
  reasons: ['All 3 words found'],
  engine: 'mock',
  ms: 5,
};

// Minimal JSON-RPC + vision stand-ins: enough to run /slot, /day, /relay validation and the whole /verify path.
describe('server against a fake RPC', () => {
  let server: Server;
  let vision: Server;
  const visionCalls: Record<string, string>[] = [];
  const sent: Uint8Array[] = [];
  const sentSigned: boolean[] = [];
  let failNextSend = false;
  let app: ReturnType<typeof createApp>;
  let programId: Address;
  let teacher: Address;
  let watchTeacher: Address;
  let paths: { deploy: string; keys: string };
  const DAY = 20715;
  const image = new TextEncoder().encode('fake jpeg bytes');
  const accounts = new Map<string, Uint8Array>();

  beforeAll(async () => {
    programId = (await generateKeyPairSigner()).address;
    teacher = (await generateKeyPairSigner()).address;
    accounts.set(
      SYSVAR_SLOT_HASHES_ADDRESS,
      encodeSlotHashes([
        { slot: 1001n, hash: new Uint8Array(32).fill(0xab) },
        { slot: 1000n, hash: new Uint8Array(32).fill(0xcd) },
        { slot: 900n, hash: new Uint8Array(32).fill(0xef) },
      ]),
    );
    const [configPda] = await findConfigPda(programId);
    accounts.set(
      configPda,
      encodeConfig({
        admin: teacher,
        oracle: teacher,
        usdcMint: teacher,
        windowSlots: 225n,
        recheckWindowSlots: 450n,
        recheckIntervalSlots: 300n,
        bonusPerLink: 600_000n,
        recheckThreshold: 64,
        maxLinks: 6,
        minHeadcount: 3,
        bump: 255,
        vaultBump: 254,
      }),
    );
    const day = (d: number, linkSlot: bigint, t = teacher) =>
      encodeDay({
        teacher: t,
        day: d,
        nLinks: 1,
        recheckPending: false,
        rechecksMet: 0,
        missedRecheck: false,
        settled: false,
        bump: 255,
        recheckFromSlot: 0n,
        recheckDeadlineSlot: 0n,
        lastRolledBoundary: 0n,
        paid: 0n,
        links: [
          {
            slot: linkSlot,
            photoHash: photoHash(image),
            seed: new Uint8Array(32),
            commit: new Uint8Array(32),
            words: [0, 1, 2],
            flags: 0,
            headcount: 0,
          },
        ],
      });
    accounts.set((await findDayPda(programId, teacher, DAY))[0], day(DAY, 1000n));
    accounts.set((await findDayPda(programId, teacher, DAY + 2))[0], day(DAY + 2, 500n));
    watchTeacher = (await generateKeyPairSigner()).address;
    accounts.set((await findDayPda(programId, watchTeacher, dayNumber()))[0], day(dayNumber(), 500n, watchTeacher));

    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const { id, method, params } = JSON.parse(raw);
        let result: unknown;
        if (method === 'getSlot') result = 1003;
        else if (method === 'getAccountInfo') {
          const data = accounts.get(params[0]);
          result = {
            context: { slot: 1003 },
            value: data
              ? { data: [toBase64(data), 'base64'], executable: false, lamports: 1, owner: programId, rentEpoch: 0, space: data.length }
              : null,
          };
        } else if (method === 'sendTransaction' && failNextSend) {
          failNextSend = false;
          res.setHeader('content-type', 'application/json');
          return res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id,
              error: {
                code: -32002,
                message: 'Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1771',
                data: {
                  err: { InstructionError: [0, { Custom: 6001 }] },
                  logs: ['Program log: AnchorError occurred. Error Code: SlotTooOld. Error Number: 6001. Error Message: slot too old.'],
                  accounts: null,
                  unitsConsumed: 1000,
                  returnData: null,
                },
              },
            }),
          );
        } else if (method === 'sendTransaction') {
          const tx = getTransactionDecoder().decode(fromBase64(params[0]));
          sent.push(new Uint8Array(tx.messageBytes));
          sentSigned.push(Object.values(tx.signatures).every(Boolean));
          result = getSignatureFromTransaction(tx);
        } else if (method === 'getSignatureStatuses') {
          result = {
            context: { slot: 1004 },
            value: [{ slot: 1004, confirmations: null, err: null, status: { Ok: null }, confirmationStatus: 'confirmed' }],
          };
        } else if (method === 'getTransaction') {
          result = { slot: 1004, blockTime: null, meta: { err: null, logMessages: ['Program log: ok'] }, transaction: {} };
        } else if (method === 'getLatestBlockhash') {
          result = { context: { slot: 1003 }, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 2000 } };
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(result === undefined ? { jsonrpc: '2.0', id, error: { code: -32601, message: method } } : { jsonrpc: '2.0', id, result }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;

    vision = createServer(async (req, res) => {
      const form = await new Request('http://x', { method: 'POST', headers: req.headers as HeadersInit, body: req as unknown as BodyInit, duplex: 'half' } as RequestInit).formData();
      const fields: Record<string, string> = {};
      for (const [k, v] of form) fields[k] = typeof v === 'string' ? v : `file:${(v as File).size}`;
      visionCalls.push(fields);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(VISION_SAMPLE));
    });
    await new Promise<void>((r) => vision.listen(0, '127.0.0.1', r));
    const visionPort = (vision.address() as { port: number }).port;

    const dir = tmp();
    writeFileSync(join(dir, 'deploy.json'), JSON.stringify({ cluster: 'localnet', rpcUrl: `http://127.0.0.1:${port}`, programId, usdcMint: SYSVAR_SLOT_HASHES_ADDRESS }));
    await writeKeys(dir);
    paths = { deploy: join(dir, 'deploy.json'), keys: dir };
    app = createApp({ paths, visionUrl: `http://127.0.0.1:${visionPort}` });
  });

  afterAll(() => {
    server?.close();
    vision?.close();
  });

  it('GET /health', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; programId: string; usdcMint: string | null };
    expect(body).toMatchObject({ ok: true, programId, usdcMint: SYSVAR_SLOT_HASHES_ADDRESS });
  });

  it('GET /slot returns the newest SlotHashes entry as hex', async () => {
    const res = await app.request('/slot');
    expect(await res.json()).toEqual({ slot: '1001', hash: 'ab'.repeat(32), currentSlot: '1003' });
  });

  it('GET /blockhash', async () => {
    const res = await app.request('/blockhash');
    expect(await res.json()).toEqual({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: '2000' });
  });

  it('GET /day resolves words; 404 for an unknown day', async () => {
    const res = await app.request(`/day/${teacher}/${DAY}?lang=en`);
    expect(res.status).toBe(200);
    const day = (await res.json()) as DayJson;
    expect(day.nLinks).toBe(1);
    expect(day.links[0]!.wordsText).toHaveLength(3);
    expect(day.links[0]!.photoHash).toBe(toHex(photoHash(image)));
    expect((await app.request(`/day/${teacher}/${DAY + 1}`)).status).toBe(404);
    expect((await app.request(`/day/not-an-address/${DAY}`)).status).toBe(400);
  });

  it('POST /verify rejects a photo that does not match the commitment', async () => {
    const form = new FormData();
    form.set('teacher', teacher);
    form.set('day', String(DAY));
    form.set('idx', '0');
    form.set('lang', 'en');
    form.set('image', new Blob([new Uint8Array([1, 2, 3])]), 'x.jpg');
    const res = await app.request('/verify', { method: 'POST', body: form });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('Photo does not match what was committed');
  });

  it('POST /verify: vision call, flags, attest sent by the oracle', async () => {
    const form = new FormData();
    form.set('teacher', teacher);
    form.set('day', String(DAY));
    form.set('idx', '0');
    form.set('lang', 'sw');
    form.set('image', new Blob([image]), 'x.jpg');
    const res = await app.request('/verify', { method: 'POST', body: form });
    const body = (await res.json()) as { flags: number; passes: boolean; attestSignature: string; headcount: number };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ flags: 0x9f, passes: true, headcount: 7 });
    expect(body.attestSignature).toBeTruthy();

    const call = visionCalls.at(-1)!;
    expect(JSON.parse(call.expected!)).toHaveLength(3);
    expect(JSON.parse(call.prior!)).toEqual([]);
    expect(call).toMatchObject({ photo_id: `${teacher}:${DAY}:0`, group_id: `${teacher}:${DAY}`, lang: 'sw', image: `file:${image.length}` });

    const ix = firstIx(sent.at(-1)!);
    expect(ix.program).toBe(programId);
    expect(identifyInstruction(ix.data)).toBe('attest');
    // discriminator(8) day(4) idx flags headcount
    expect([...ix.data.slice(12)]).toEqual([0, 0x1f, 7]);
  });

  async function checkInTx(): Promise<string> {
    const { relayer } = (await (await app.request('/health')).json()) as { relayer: Address };
    const t = await generateKeyPairSigner();
    const ix = await getCheckInInstruction({ programAddress: programId, payer: relayer, teacher: t, day: DAY, slot: 1001n, photoHash: photoHash(image) });
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(createNoopSigner(relayer), m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash('11111111111111111111111111111111'), lastValidBlockHeight: 2000n }, m),
      (m) => appendTransactionMessageInstruction(ix, m),
    );
    return getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(msg));
  }
  const post = (path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('POST /relay co-signs, sends and confirms', async () => {
    const res = await post('/relay', { tx: await checkInTx() });
    const body = (await res.json()) as { signature: string; slot: string };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.slot).toBe('1004');
    expect(sentSigned.at(-1)).toBe(true);
    expect(identifyInstruction(firstIx(sent.at(-1)!).data)).toBe('check_in');
  });

  it('POST /relay maps a program error to the friendly text and code', async () => {
    failNextSend = true;
    const res = await post('/relay', { tx: await checkInTx() });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 6001, error: 'Photo sent too late. Get new words and try again.' });
  });

  it('POST /roll: no boundary yet → 409 with the next boundary', async () => {
    const res = await post('/roll', { teacher, day: DAY });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ currentSlot: '1003', nextBoundary: '1200' });
  });

  it('POST /roll cranks roll_recheck at the latest boundary', async () => {
    const res = await post('/roll', { teacher, day: DAY + 2 });
    const body = (await res.json()) as { boundarySlot: string; hit: boolean };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ boundarySlot: '900', hit: false });
    const ix = firstIx(sent.at(-1)!);
    expect(identifyInstruction(ix.data)).toBe('roll_recheck');
    expect(new DataView(ix.data.buffer).getBigUint64(12, true)).toBe(900n);
  });

  it('POST /watch without CHALK_AUTO_ROLL: accepted but not watched', async () => {
    const res = await post('/watch', { teacher: watchTeacher, day: dayNumber() });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ watching: false, autoRoll: { enabled: false, active: 0, lastRoll: null } });
    expect(await (await app.request('/health')).json()).toMatchObject({ rateLimit: true, autoRoll: { enabled: false } });
  });

  it('auto-roll: /watch validates the day, then the cranker rolls it once', async () => {
    const auto = createApp({ paths, autoRoll: { enabled: true, intervalMs: 3_600_000 } });
    const watch = (body: unknown) =>
      auto.request('/watch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await watch({ teacher: watchTeacher, day: dayNumber() + 1 })).status).toBe(404);
    expect((await watch({ teacher: watchTeacher, day: dayNumber() - 2 })).status).toBe(409);
    const res = await watch({ teacher: watchTeacher, day: dayNumber() });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ watching: true, autoRoll: { enabled: true, active: 1 } });

    const before = sent.length;
    await auto.autoRoller.tick();
    await auto.autoRoller.tick();
    expect(sent.length).toBe(before + 1);
    const ix = firstIx(sent.at(-1)!);
    expect(identifyInstruction(ix.data)).toBe('roll_recheck');
    expect(new DataView(ix.data.buffer).getBigUint64(12, true)).toBe(900n);
    const health = (await (await auto.request('/health')).json()) as { autoRoll: { active: number; lastRoll: { boundarySlot: string; hit: boolean } } };
    expect(health.autoRoll).toMatchObject({ active: 1, lastRoll: { boundarySlot: '900', hit: false } });
    auto.autoRoller.stop();
  });

  it('POST /settle sends [ATA CreateIdempotent, settle_day]', async () => {
    const res = await post('/settle', { teacher, day: DAY });
    const body = (await res.json()) as { amount: string };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.amount).toBe('0');
    const msg = getCompiledTransactionMessageDecoder().decode(sent.at(-1)!);
    if (msg.version === 1) throw new Error('v1');
    expect(msg.instructions.map((i) => msg.staticAccounts[i.programAddressIndex])).toEqual([
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
      programId,
    ]);
  });

  it('POST /relay rejects before touching the chain', async () => {
    const res = await app.request('/relay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tx: 'AAAA' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: number | null };
    expect(body.code).toBeNull();
    expect(body.error).toMatch(/Not a valid transaction/);
  });
});
