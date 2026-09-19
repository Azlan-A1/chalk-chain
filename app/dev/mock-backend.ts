// In-memory stand-in for backend/ (SPEC §4) so the app can be exercised without a validator.
// Run: node app/dev/mock-backend.ts   (port 8787). Signatures are NOT verified; nothing touches Solana.
// Knobs: SLOT_LAG=224 serves nearly expired words (SlotTooOld path), FAIL_CHECK=people fails a check.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import {
  address,
  getBase58Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Address,
} from '@solana/kit';
import {
  ATTESTED,
  configToJson,
  decodeDay,
  deriveLink,
  dayToJson,
  encodeDay,
  ERROR_CODES,
  ERROR_MESSAGES,
  identifyInstruction,
  isLang,
  prevFor,
  addressBytes,
  bytesToAddress,
  projectedPayout,
  teacherToJson,
  toHex,
  type ChalkErrorName,
  type ConfigAccount,
  type DayInput,
  type TeacherAccount,
} from '@chalk/shared';

const PORT = Number(process.env.PORT ?? 8787);
const SLOT_MS = 400;
const T0 = Date.now();
const PROGRAM = address('5QfoP2K5HQWgmwA4YVNW8uMTccx4XHd3uFk7Ajg2xUJG');
const RELAYER = bytesToAddress(new Uint8Array(32).fill(1));
const ORACLE = bytesToAddress(new Uint8Array(32).fill(2));

const config: ConfigAccount = {
  admin: ORACLE,
  oracle: ORACLE,
  usdcMint: address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  windowSlots: BigInt(process.env.WINDOW_SLOTS ?? 225),
  recheckWindowSlots: 750n,
  recheckIntervalSlots: 150n,
  bonusPerLink: 250_000n,
  recheckThreshold: 128,
  maxLinks: 6,
  minHeadcount: 1,
  bump: 255,
  vaultBump: 254,
};

const nowSlot = () => 1000 + Math.floor((Date.now() - T0) / SLOT_MS);
const slotHashes = new Map<number, Uint8Array>();
const hashOf = (slot: number) => {
  let h = slotHashes.get(slot);
  if (!h) slotHashes.set(slot, (h = new Uint8Array(randomBytes(32))));
  return h;
};
const teachers = new Map<string, TeacherAccount>();
const days = new Map<string, DayInput>();
const dayKey = (w: string, d: number) => `${w}:${d}`;

class Fail extends Error {
  code: ChalkErrorName;
  constructor(code: ChalkErrorName) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

const u32 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset).getUint32(o, true);
const u64 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset).getBigUint64(o, true);

function relay(b64: string) {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(b64));
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (!('instructions' in msg)) throw new Error('v0 only');
  const now = nowSlot();
  for (const ix of msg.instructions) {
    const data = new Uint8Array(ix.data ?? []);
    const acct = (i: number) => msg.staticAccounts[ix.accountIndices![i]!]! as Address;
    const name = identifyInstruction(data);
    if (name === 'register_teacher') {
      const w = acct(1);
      teachers.set(w, { wallet: w, schoolId: u32(data, 8), daysSettled: 0, totalPaid: 0n, bump: 255 });
    } else if (name === 'check_in' || name === 'recheck_in') {
      const w = name === 'check_in' ? acct(1) : acct(0);
      const day = u32(data, 8);
      const slot = Number(u64(data, 12));
      const photo = data.slice(20, 52);
      const clockDay = Math.floor(Date.now() / 86_400_000);
      if (day !== clockDay && day + 1 !== clockDay) throw new Fail('DayMismatch');
      if (now - slot > Number(config.windowSlots)) throw new Fail('SlotTooOld');
      if (!slotHashes.has(slot)) throw new Fail('SlotNotFound');
      let d = days.get(dayKey(w, day));
      if (name === 'check_in') {
        if (d) throw new Error('Day account already exists');
        d = { teacher: w, day, nLinks: 0, recheckPending: false, rechecksMet: 0, missedRecheck: false, settled: false, bump: 255, recheckFromSlot: 0n, recheckDeadlineSlot: 0n, lastRolledBoundary: 0n, paid: 0n, links: [] };
      } else {
        if (!d || !d.recheckPending) throw new Fail('NoRecheckPending');
        if (now > Number(d.recheckDeadlineSlot)) throw new Fail('RecheckExpired');
        if (slot < Number(d.recheckFromSlot)) throw new Fail('SlotBeforeRecheck');
        if (slot <= Number(d.links[d.nLinks - 1]!.slot)) throw new Fail('SlotNotIncreasing');
        if (d.nLinks >= config.maxLinks) throw new Fail('TooManyLinks');
      }
      const tb = addressBytes(w);
      const prev = prevFor(tb, day, d.nLinks ? d.links[d.nLinks - 1]!.commit : null);
      const l = deriveLink(d.nLinks, hashOf(slot), tb, prev, photo);
      d = {
        ...d,
        nLinks: d.nLinks + 1,
        recheckPending: false,
        rechecksMet: name === 'recheck_in' ? d.rechecksMet + 1 : d.rechecksMet,
        links: [...d.links, { slot: BigInt(slot), photoHash: photo, seed: l.seed, commit: l.commit, words: l.words, flags: 0, headcount: 0 }],
      };
      days.set(dayKey(w, day), d);
      return { signature: getBase58Decoder().decode(randomBytes(64)), slot: now, slotAge: now - slot };
    } else if (name !== null) {
      throw new Error(`mock: ${name} is not relayed`);
    }
  }
  return { signature: getBase58Decoder().decode(randomBytes(64)), slot: now };
}

function mutateDay(w: string, day: number, fn: (d: DayInput) => DayInput) {
  const d = days.get(dayKey(w, day));
  if (!d) throw new Error('No Day account');
  days.set(dayKey(w, day), fn(d));
  return days.get(dayKey(w, day))!;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'OPTIONS') return send(res, 204, null);
    if (req.method === 'GET') {
      if (p[0] === 'health') return send(res, 200, { ok: true, cluster: 'mock', rpcUrl: 'mock', programId: PROGRAM, usdcMint: config.usdcMint, relayer: RELAYER, oracle: ORACLE });
      if (p[0] === 'config') return send(res, 200, { ...configToJson(config), slotMs: SLOT_MS });
      if (p[0] === 'slot') {
        const cur = nowSlot();
        const s = cur - Number(process.env.SLOT_LAG ?? 2);
        return send(res, 200, { slot: s, hash: toHex(hashOf(s)), currentSlot: cur });
      }
      if (p[0] === 'blockhash') return send(res, 200, { blockhash: getBase58Decoder().decode(randomBytes(32)), lastValidBlockHeight: 9999 });
      if (p[0] === 'teacher') {
        const t = teachers.get(p[1]!);
        return t ? send(res, 200, teacherToJson(t)) : send(res, 404, { error: 'not found' });
      }
      if (p[0] === 'day') {
        const d = days.get(dayKey(p[1]!, Number(p[2])));
        const lang = url.searchParams.get('lang');
        return d ? send(res, 200, dayToJson(decodeDay(encodeDay(d)), isLang(lang) ? lang : 'en')) : send(res, 404, { error: 'not found' });
      }
    }
    if (req.method === 'POST') {
      const raw = await body(req);
      if (p[0] === 'verify') {
        const form = await new Request('http://x', { method: 'POST', headers: { 'content-type': req.headers['content-type']! }, body: raw }).formData();
        const teacher = String(form.get('teacher'));
        const day = Number(form.get('day'));
        const idx = Number(form.get('idx'));
        const img = form.get('image') as File;
        await new Promise((r) => setTimeout(r, 1200));
        const fail = process.env.FAIL_CHECK === 'people';
        const flags = fail ? 0x0f : 0x1f;
        mutateDay(teacher, day, (d) => ({ ...d, links: d.links.map((l, i) => (i === idx ? { ...l, flags: flags | ATTESTED, headcount: fail ? 0 : 7 } : l)) }));
        return send(res, 200, {
          words_ok: true, words_found: [true, true, true], chain_ok: true, prior_found: [], decoys_flagged: [],
          headcount: fail ? 0 : 7, is_recapture: false, recapture_score: 0.1,
          reuse: { is_reuse: false, distance: 118, match_id: null, exact_duplicate: false },
          reasons: [`mock: got ${img.size} bytes`], engine: 'mock', ms: 1200, flags, attestSignature: 'mock',
        });
      }
      const j = JSON.parse(raw.toString() || '{}');
      if (p[0] === 'relay') return send(res, 200, relay(j.tx));
      if (p[0] === 'recheck' || p[0] === 'roll') {
        const hit = p[0] === 'recheck' || Math.random() < 0.5;
        const now = nowSlot();
        if (hit) mutateDay(j.teacher, j.day, (d) => {
          if (d.recheckPending) throw new Fail('RecheckInProgress');
          return { ...d, recheckPending: true, recheckFromSlot: BigInt(now), recheckDeadlineSlot: BigInt(now) + config.recheckWindowSlots };
        });
        return send(res, 200, { signature: 'mock', hit });
      }
      if (p[0] === 'settle') {
        const d = mutateDay(j.teacher, j.day, (d) => {
          if (d.settled) throw new Fail('AlreadySettled');
          const missed = d.recheckPending;
          const acct = decodeDay(encodeDay({ ...d, missedRecheck: missed }));
          const amount = projectedPayout(acct, config.bonusPerLink).amount;
          return { ...d, settled: true, recheckPending: false, missedRecheck: missed, paid: amount };
        });
        return send(res, 200, { signature: 'mock', amount: d.paid.toString() });
      }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    if (e instanceof Fail) return send(res, 400, { error: e.message, code: ERROR_CODES[e.code] });
    send(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, () => console.log(`mock backend on http://localhost:${PORT}`));
