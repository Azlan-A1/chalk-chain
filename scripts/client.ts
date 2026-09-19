/** Backend + chain client used by e2e.ts and the demo tools: acts exactly like the app. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  address,
  appendTransactionMessageInstructions,
  blockhash as toBlockhash,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit';
import {
  addressBytes,
  challenge,
  dayFromJson,
  findAssociatedTokenAddress,
  fromHex,
  getCheckInInstruction,
  getRecheckInInstruction,
  getRegisterTeacherInstruction,
  photoHash,
  prevFor,
  type DayJson,
} from '@chalk/shared';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BACKEND = (process.env.BACKEND ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
export const deploy = JSON.parse(readFileSync(process.env.CHALK_DEPLOY ?? join(ROOT, 'shared/deploy.json'), 'utf8'));
export const rpc = createSolanaRpc(deploy.rpcUrl);
export const LANG = 'en';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Fresh scene per photo: fixed seeds would make reruns near-duplicates of earlier runs' photos.
export const rnd = () => Math.floor(Math.random() * 2 ** 31);

// ---- backend client ----

export async function api<T = any>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BACKEND}${path}`, init);
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}
export const post = (path: string, json: unknown) =>
  api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) });

/** Same shape the app builds: v0, relayer (no-op signer) pays, teacher signs. */
export async function relayTx(instructions: Instruction[], relayer: Address) {
  const { body: bh } = await api('/blockhash');
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(createNoopSigner(relayer), m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: toBlockhash(bh.blockhash), lastValidBlockHeight: BigInt(bh.lastValidBlockHeight) },
        m,
      ),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const tx = getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(msg));
  return post('/relay', { tx });
}

/** A real JPEG of a classroom with the words chalked on the board (vision/tests/synth.py). */
export function photo(words: string[], seed: number): Uint8Array {
  const py = join(ROOT, 'vision/.venv/bin/python');
  const code = [
    'import sys, json',
    `sys.path.insert(0, ${JSON.stringify(join(ROOT, 'vision/tests'))})`,
    'import synth',
    'img = synth.classroom(json.loads(sys.argv[1]), seed=int(sys.argv[2]), size=(800, 600))',
    'sys.stdout.buffer.write(synth.jpeg(img, quality=85))',
  ].join('\n');
  return new Uint8Array(execFileSync(py, ['-c', code, JSON.stringify(words), String(seed)], { maxBuffer: 16 << 20 }));
}

export async function verify(teacher: Address, day: number, idx: number, image: Uint8Array) {
  const form = new FormData();
  form.set('teacher', teacher);
  form.set('day', String(day));
  form.set('idx', String(idx));
  form.set('lang', LANG);
  form.set('image', new Blob([new Uint8Array(image)], { type: 'image/jpeg' }), 'photo.jpg');
  return api('/verify', { method: 'POST', body: form });
}

export async function getDay(teacher: Address, day: number) {
  const { status, body } = await api<DayJson>(`/day/${teacher}/${day}?lang=${LANG}`);
  if (status !== 200) throw new Error(`GET /day ${status}: ${JSON.stringify(body)}`);
  return { json: body, day: dayFromJson(body) };
}

/** GET /slot, waiting until the newest SlotHashes entry is at least `minSlot`. */
export async function freshSlot(minSlot = 0n): Promise<{ slot: bigint; hash: Uint8Array }> {
  for (let i = 0; i < 60; i++) {
    const { body } = await api('/slot');
    if (BigInt(body.slot) >= minSlot) return { slot: BigInt(body.slot), hash: fromHex(body.hash) };
    await sleep(250);
  }
  throw new Error(`SlotHashes never reached slot ${minSlot}`);
}

export async function usdcBalance(owner: Address): Promise<bigint> {
  const [ata] = await findAssociatedTokenAddress(owner, address(deploy.usdcMint));
  try {
    const { value } = await rpc.getTokenAccountBalance(ata, { commitment: 'confirmed' }).send();
    return BigInt(value.amount);
  } catch {
    return 0n;
  }
}

export async function register(teacher: KeyPairSigner, relayer: Address, schoolId: number) {
  const ix = await getRegisterTeacherInstruction({
    programAddress: deploy.programId,
    payer: relayer,
    teacher,
    schoolId,
  });
  return relayTx([ix], relayer);
}

/** Derive words from a fresh slot, photograph them, commit via check_in or recheck_in. */
export async function commitLink(opts: {
  teacher: KeyPairSigner;
  relayer: Address;
  day: number;
  lastCommit: Uint8Array | null;
  minSlot?: bigint;
  image?: Uint8Array;
  seed: number;
}) {
  const { teacher, relayer, day } = opts;
  const { slot, hash } = await freshSlot(opts.minSlot ?? 0n);
  const prev = prevFor(addressBytes(teacher.address), day, opts.lastCommit);
  const { words } = challenge(hash, addressBytes(teacher.address), prev, LANG);
  const image = opts.image ?? photo(words, opts.seed);
  const args = { programAddress: deploy.programId, teacher, day, slot, photoHash: photoHash(image) };
  const ix = opts.lastCommit
    ? await getRecheckInInstruction(args)
    : await getCheckInInstruction({ ...args, payer: relayer });
  const res = await relayTx([ix], relayer);
  return { res, words, image, slot };
}

