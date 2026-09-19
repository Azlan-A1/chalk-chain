import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { address, isAddress, isSolanaError, type Address } from '@solana/kit';
import {
  ATTESTED,
  MAX_LINKS,
  SYSVAR_SLOT_HASHES_ADDRESS,
  bytesEqual,
  configToJson,
  dayNumber,
  dayToJson,
  decodeConfig,
  decodeDay,
  decodeTeacher,
  extractCustomErrorCode,
  findConfigPda,
  findDayPda,
  findTeacherPda,
  fromBase64,
  friendlyErrorMessage,
  getAttestInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getRollRecheckInstruction,
  getSettleDayInstruction,
  getTriggerRecheckInstruction,
  isLang,
  linkPasses,
  newest,
  parseEventsFromLogs,
  parseSlotHashes,
  photoHash,
  teacherToJson,
  toHex,
  toJsonSafe,
  wordsFor,
  type ChalkEvent,
  type ConfigAccount,
  type DayAccount,
  type Lang,
} from '@chalk/shared';
import { AutoRoller, type AutoRollView, type RollResult } from './autoroll.ts';
import { planRoll } from './boundary.ts';
import { ctxLoader, requireAddress, type Ctx } from './ctx.ts';
import { AUTO_ROLL, AUTO_ROLL_MS, RATE_LIMIT, SetupError, VISION_URL, defaultPaths, type Paths } from './env.ts';
import { flagsFromVision, type VisionResult } from './flags.ts';
import { DEFAULT_LIMITS, rateLimit, type Limits } from './ratelimit.ts';
import { checkRelayTransaction, cosign } from './relay.ts';
import { TxError, fetchData, measureSlotMs, sendAndConfirmWire, sendInstructions, type Rpc } from './tx.ts';

export interface AppOptions {
  paths?: Paths;
  visionUrl?: string;
  getCtx?: () => Promise<Ctx>;
  /** Per-IP limits on POST routes (requests per minute); false disables. Default: DEFAULT_LIMITS unless CHALK_RATE_LIMIT=0. */
  rateLimit?: Limits | false;
  /** roll_recheck cranker. Default: CHALK_AUTO_ROLL / CHALK_AUTO_ROLL_MS. */
  autoRoll?: { enabled: boolean; intervalMs?: number };
}

const bad = (message: string, status: 400 | 404 | 409 | 502 | 503 = 400, extra: object = {}) =>
  new HTTPException(status, { res: Response.json({ error: message, code: null, message, ...extra }, { status }) });

function event<N extends ChalkEvent['name']>(logs: string[], name: N) {
  return parseEventsFromLogs(logs).find((e): e is Extract<ChalkEvent, { name: N }> => e.name === name);
}

/** Error text plus its causes, e.g. "Transaction simulation failed: Attempt to load a program that does not exist". */
function describeError(err: unknown): string {
  const parts: string[] = [];
  for (let e = err as { message?: unknown; cause?: unknown } | undefined, i = 0; e && i < 5; e = e.cause as typeof e, i++) {
    if (typeof e.message === 'string' && e.message && !parts.includes(e.message)) parts.push(e.message);
  }
  return parts.join(': ') || String(err);
}

function errorLogs(err: unknown): string[] {
  const e = err as { logs?: unknown; context?: { logs?: unknown } };
  const logs = e.logs ?? e.context?.logs;
  return Array.isArray(logs) ? logs.filter((l): l is string => typeof l === 'string').slice(-20) : [];
}

// ---- input parsing ----

function parseWallet(v: unknown): Address {
  if (typeof v !== 'string' || !isAddress(v)) throw bad('teacher must be a base58 wallet address');
  return address(v);
}
function parseInt32(v: unknown, name: string, max = 0xffffffff): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > max) throw bad(`${name} must be an integer 0..${max}`);
  return n;
}
function parseLang(v: unknown): Lang {
  if (v === undefined || v === null || v === '') return 'en';
  if (!isLang(v)) throw bad('lang must be en or sw');
  return v;
}
async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json();
    if (b && typeof b === 'object') return b as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw bad('Body must be JSON');
}

// ---- chain reads ----

async function getConfig(ctx: Ctx): Promise<ConfigAccount> {
  const [pda] = await findConfigPda(ctx.programId);
  const data = await fetchData(ctx.rpc, pda);
  if (!data) throw new SetupError('Config account not found. Run `pnpm --filter backend admin init-config`.');
  return decodeConfig(data);
}

async function getDay(ctx: Ctx, teacher: Address, day: number): Promise<DayAccount | null> {
  const [pda] = await findDayPda(ctx.programId, teacher, day);
  const data = await fetchData(ctx.rpc, pda);
  return data ? decodeDay(data) : null;
}

async function mustGetDay(ctx: Ctx, teacher: Address, day: number): Promise<DayAccount> {
  const d = await getDay(ctx, teacher, day);
  if (!d) throw bad('No check-in for that day', 404);
  return d;
}

async function slotHashes(rpc: Rpc) {
  const { value } = await rpc
    .getAccountInfo(SYSVAR_SLOT_HASHES_ADDRESS, { encoding: 'base64', commitment: 'confirmed' })
    .send();
  if (!value) throw new Error('SlotHashes sysvar not found');
  return parseSlotHashes(fromBase64(value.data[0]));
}

async function rollView(ctx: Ctx): Promise<AutoRollView> {
  const [config, entries, currentSlot] = await Promise.all([
    getConfig(ctx),
    slotHashes(ctx.rpc),
    ctx.rpc.getSlot({ commitment: 'confirmed' }).send(),
  ]);
  return {
    currentSlot,
    interval: config.recheckIntervalSlots,
    maxLinks: Math.min(config.maxLinks, MAX_LINKS),
    slotHashes: entries,
  };
}

async function sendRoll(ctx: Ctx, teacher: Address, day: number, boundarySlot: bigint): Promise<RollResult> {
  const ix = await getRollRecheckInstruction({
    programAddress: ctx.programId,
    cranker: ctx.relayer,
    teacher,
    day,
    boundarySlot,
  });
  const landed = await sendInstructions(ctx.rpc, ctx.relayer, [ix]);
  const ev = event(landed.logs, 'RecheckRolled');
  const hit = ev ? ev.hit : ((await getDay(ctx, teacher, day))?.recheckPending ?? null);
  return { signature: landed.signature, boundarySlot, hit, roll: ev?.roll ?? null };
}

// ---- app ----

export type ChalkApp = Hono & { autoRoller: AutoRoller };

export function createApp(opts: AppOptions = {}): ChalkApp {
  const paths = opts.paths ?? defaultPaths();
  const getCtx = opts.getCtx ?? ctxLoader(paths);
  const visionUrl = (opts.visionUrl ?? VISION_URL).replace(/\/$/, '');
  const limits = opts.rateLimit ?? (RATE_LIMIT ? DEFAULT_LIMITS : false);
  const roller = new AutoRoller(
    {
      view: async () => rollView(await getCtx()),
      getDay: async (teacher, day) => getDay(await getCtx(), teacher, day),
      roll: async (teacher, day, boundarySlot) => sendRoll(await getCtx(), teacher, day, boundarySlot),
    },
    opts.autoRoll ?? { enabled: AUTO_ROLL, intervalMs: AUTO_ROLL_MS },
  );
  roller.start();
  const app = new Hono();

  app.use('*', cors());
  if (limits) app.use('*', rateLimit(limits));

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof SetupError) return c.json({ ok: false, error: err.message, code: null, message: err.message }, 503);
    const code = extractCustomErrorCode(err);
    const message = describeError(err);
    if (code !== null || err instanceof TxError || isSolanaError(err)) {
      return c.json({ error: friendlyErrorMessage(err, message), code, message, logs: errorLogs(err) }, 400);
    }
    console.error(err);
    return c.json({ error: 'Something went wrong. Try again.', code: null, message }, 500);
  });

  app.get('/health', async (c) => {
    try {
      const ctx = await getCtx();
      return c.json({
        ok: true,
        cluster: ctx.deploy.cluster,
        rpcUrl: ctx.deploy.rpcUrl,
        programId: ctx.programId,
        usdcMint: ctx.usdcMint,
        relayer: ctx.relayer.address,
        oracle: ctx.oracle.address,
        visionUrl,
        warnings: ctx.warnings,
        rateLimit: limits !== false,
        autoRoll: roller.status(),
      });
    } catch (e) {
      if (!(e instanceof SetupError)) throw e;
      return c.json({ ok: false, error: e.message }, 503);
    }
  });

  app.get('/config', async (c) => {
    const ctx = await getCtx();
    const [config, slotMs] = await Promise.all([getConfig(ctx), measureSlotMs(ctx.rpc)]);
    return c.json({ ...configToJson(config), slotMs });
  });

  app.get('/slot', async (c) => {
    const ctx = await getCtx();
    const [entries, currentSlot] = await Promise.all([
      slotHashes(ctx.rpc),
      ctx.rpc.getSlot({ commitment: 'confirmed' }).send(),
    ]);
    const top = newest(entries);
    if (!top) throw new Error('SlotHashes is empty');
    return c.json({ slot: top.slot.toString(), hash: toHex(top.hash), currentSlot: currentSlot.toString() });
  });

  app.get('/blockhash', async (c) => {
    const ctx = await getCtx();
    const { value } = await ctx.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    return c.json({ blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight.toString() });
  });

  app.get('/teacher/:wallet', async (c) => {
    const ctx = await getCtx();
    const [pda] = await findTeacherPda(ctx.programId, parseWallet(c.req.param('wallet')));
    const data = await fetchData(ctx.rpc, pda);
    if (!data) throw bad('Teacher not registered', 404);
    return c.json(teacherToJson(decodeTeacher(data)));
  });

  app.get('/day/:wallet/:day', async (c) => {
    const ctx = await getCtx();
    const lang = parseLang(c.req.query('lang'));
    const day = await mustGetDay(ctx, parseWallet(c.req.param('wallet')), parseInt32(c.req.param('day'), 'day'));
    return c.json(dayToJson(day, lang));
  });

  app.post('/relay', async (c) => {
    const ctx = await getCtx();
    const body = await jsonBody(c);
    const check = checkRelayTransaction(body.tx, {
      relayer: ctx.relayer.address,
      programId: ctx.programId,
      usdcMint: ctx.usdcMint,
    });
    if (!check.ok) throw bad(check.reason);
    let signed;
    try {
      signed = await cosign(check.tx, ctx.relayer);
    } catch {
      throw bad('Transaction is missing a signature');
    }
    const landed = await sendAndConfirmWire(ctx.rpc, signed.wire, signed.signature);
    const events = parseEventsFromLogs(landed.logs);
    const checkedIn = event(landed.logs, 'CheckedIn');
    for (const e of events) if (e.name === 'CheckedIn') roller.watch(e.teacher, e.day);
    return c.json({
      signature: landed.signature,
      slot: landed.slot.toString(),
      slotAge: checkedIn ? checkedIn.slotAge.toString() : null,
      instructions: check.instructions,
      events: toJsonSafe(events),
    });
  });

  app.post('/verify', async (c) => {
    const ctx = await getCtx();
    let form: Record<string, string | File>;
    try {
      form = (await c.req.parseBody()) as Record<string, string | File>;
    } catch {
      throw bad('Body must be multipart/form-data');
    }
    const teacher = parseWallet(form.teacher);
    const dayNum = parseInt32(form.day, 'day');
    const idx = parseInt32(form.idx, 'idx', 255);
    const lang = parseLang(form.lang);
    const image = form.image;
    if (!(image instanceof File)) throw bad('image file is required');
    const bytes = new Uint8Array(await image.arrayBuffer());

    const [day, config] = await Promise.all([mustGetDay(ctx, teacher, dayNum), getConfig(ctx)]);
    const link = day.links[idx];
    if (!link) throw bad("That photo doesn't exist.", 400, { code: 6011 });
    if (day.settled) throw bad('Today is already settled.', 409, { code: 6010 });
    if (!bytesEqual(photoHash(bytes), link.photoHash)) throw bad('Photo does not match what was committed');

    const expected = wordsFor(link.words, lang);
    const prior = day.links.slice(0, idx).map((l) => wordsFor(l.words, lang));
    const vf = new FormData();
    vf.set('image', new Blob([bytes], { type: image.type || 'application/octet-stream' }), image.name || 'photo.jpg');
    vf.set('expected', JSON.stringify(expected));
    vf.set('prior', JSON.stringify(prior));
    vf.set('photo_id', `${teacher}:${dayNum}:${idx}`);
    vf.set('group_id', `${teacher}:${dayNum}`);
    vf.set('lang', lang);
    let vision: VisionResult;
    try {
      const res = await fetch(`${visionUrl}/verify`, { method: 'POST', body: vf, signal: AbortSignal.timeout(90_000) });
      if (!res.ok) throw new Error(`vision ${res.status}: ${(await res.text()).slice(0, 300)}`);
      vision = (await res.json()) as VisionResult;
    } catch (e) {
      throw bad('The photo checker is not responding. Try again soon.', 502, { message: (e as Error).message });
    }

    const flags = flagsFromVision(vision, config.minHeadcount, idx);
    const ix = await getAttestInstruction({
      programAddress: ctx.programId,
      oracle: ctx.oracle,
      teacher,
      day: dayNum,
      idx,
      flags,
      headcount: Number(vision.headcount) || 0,
    });
    const landed = await sendInstructions(ctx.rpc, ctx.oracle, [ix]);
    const stored = flags | ATTESTED;
    return c.json({
      ...vision,
      expected,
      prior,
      flags: stored,
      passes: linkPasses(stored),
      attestSignature: landed.signature,
    });
  });

  app.post('/recheck', async (c) => {
    const ctx = await getCtx();
    const body = await jsonBody(c);
    const teacher = parseWallet(body.teacher);
    const day = parseInt32(body.day, 'day');
    const ix = await getTriggerRecheckInstruction({ programAddress: ctx.programId, oracle: ctx.oracle, teacher, day });
    const landed = await sendInstructions(ctx.rpc, ctx.oracle, [ix]);
    const ev = event(landed.logs, 'RecheckStarted');
    return c.json({
      signature: landed.signature,
      fromSlot: ev?.fromSlot.toString() ?? null,
      deadlineSlot: ev?.deadlineSlot.toString() ?? null,
    });
  });

  app.post('/roll', async (c) => {
    const ctx = await getCtx();
    const body = await jsonBody(c);
    const teacher = parseWallet(body.teacher);
    const dayNum = parseInt32(body.day, 'day');
    const [day, view] = await Promise.all([mustGetDay(ctx, teacher, dayNum), rollView(ctx)]);
    const plan = planRoll(day, view);
    if (plan.kind === 'settled') throw bad('Today is already settled.', 409, { code: 6010 });
    if (plan.kind === 'pending') throw bad('A re-check is still open.', 409, { code: 6008 });
    if (plan.kind === 'missing') throw bad('No check-in for that day', 404);
    if (plan.kind === 'wait') {
      throw bad('No re-check boundary to roll yet.', 409, {
        currentSlot: view.currentSlot.toString(),
        nextBoundary: plan.nextBoundary?.toString() ?? null,
      });
    }
    const r = await sendRoll(ctx, teacher, dayNum, plan.boundarySlot);
    roller.watch(teacher, dayNum);
    return c.json({ signature: r.signature, boundarySlot: r.boundarySlot.toString(), hit: r.hit, roll: r.roll });
  });

  app.post('/watch', async (c) => {
    const body = await jsonBody(c);
    const teacher = parseWallet(body.teacher);
    const dayNum = parseInt32(body.day, 'day');
    if (!roller.enabled) return c.json({ watching: false, autoRoll: roller.status() });
    if (dayNum + 1 < dayNumber()) throw bad('That day is over.', 409);
    const day = await mustGetDay(await getCtx(), teacher, dayNum);
    if (day.settled) throw bad('Today is already settled.', 409, { code: 6010 });
    if (!roller.watch(teacher, dayNum)) throw bad('Too many days are being watched. Try again later.', 503);
    return c.json({ watching: true, autoRoll: roller.status() });
  });

  app.post('/settle', async (c) => {
    const ctx = await getCtx();
    const body = await jsonBody(c);
    const teacher = parseWallet(body.teacher);
    const day = parseInt32(body.day, 'day');
    const usdcMint = ctx.usdcMint ?? requireAddress(ctx.deploy, 'usdcMint', 'Run `admin create-mint`.');
    const ixs = [
      await getCreateAssociatedTokenIdempotentInstruction({ payer: ctx.oracle, owner: teacher, mint: usdcMint }),
      await getSettleDayInstruction({ programAddress: ctx.programId, oracle: ctx.oracle, teacher, day, usdcMint }),
    ];
    const landed = await sendInstructions(ctx.rpc, ctx.oracle, ixs);
    const ev = event(landed.logs, 'Settled');
    const amount = ev ? ev.amount : ((await getDay(ctx, teacher, day))?.paid ?? null);
    return c.json({
      signature: landed.signature,
      amount: amount?.toString() ?? null,
      passing: ev?.passing ?? null,
      missedRecheck: ev?.missedRecheck ?? null,
    });
  });

  return Object.assign(app, { autoRoller: roller });
}
