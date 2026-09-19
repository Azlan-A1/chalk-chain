/**
 * Stage demo helpers, run against the stack that scripts/demo.sh starts.
 *
 *   pnpm demo:cheat late      a photo sealed after the window closed → rejected by the program
 *   pnpm demo:cheat screen    fresh words, but photographed off a laptop screen → fails the photo check
 *   pnpm demo:cheat edited    an old class photo with today's words pasted on → flagged as reused
 *   pnpm demo:cheat all       the three in a row
 *   pnpm demo:cheat projector open the proof page of the real teacher who checked in most recently
 *   (demo.sh also uses: seed, qr <url>)
 *
 * Every cheat runs as a fresh "cheater" teacher (school 999): a teacher gets one check-in per day.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { address, generateKeyPairSigner, type Address, type KeyPairSigner } from '@solana/kit';
import qrcode from 'qrcode-terminal';
import {
  SYSVAR_SLOT_HASHES_ADDRESS,
  addressBytes,
  challenge,
  dayNumber,
  decodeDay,
  decodeTeacher,
  findTeacherPda,
  getCheckInInstruction,
  parseSlotHashes,
  photoHash,
  prevFor,
} from '@chalk/shared';
import { LANG, ROOT, api, deploy, freshSlot, register, relayTx, rpc, sleep, verify } from './client.ts';

const OUT = join(ROOT, '.run/demo');
const TEAM_OLD_PHOTO = join(ROOT, 'demo/old-class-photo.jpg');
const OLD_PHOTO = existsSync(TEAM_OLD_PHOTO) ? TEAM_OLD_PHOTO : join(OUT, 'old-class-photo.jpg');
const APP_URL = (process.env.DEMO_APP_URL ?? 'https://localhost:5173').replace(/\/$/, '');
const VISION = 'http://127.0.0.1:8001';
const CHEATER_SCHOOL = 999;

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

function images(...args: string[]): void {
  execFileSync(join(ROOT, 'vision/.venv/bin/python'), [join(ROOT, 'vision/demo_images.py'), ...args]);
}

function proofUrl(teacher: Address, day = dayNumber()): string {
  return `${APP_URL}/#/t/${teacher}/${day}?lang=${LANG}`;
}

async function relayer(): Promise<Address> {
  const { body } = await api('/health');
  if (!body?.relayer) throw new Error('backend is not running; start it with scripts/demo.sh');
  return address(body.relayer);
}

async function cheater(payer: Address): Promise<KeyPairSigner> {
  const teacher = await generateKeyPairSigner();
  const res = await register(teacher, payer, CHEATER_SCHOOL);
  if (res.status !== 200) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  return teacher;
}

async function slotHashes() {
  const { value } = await rpc
    .getAccountInfo(SYSVAR_SLOT_HASHES_ADDRESS, { encoding: 'base64', commitment: 'confirmed' })
    .send();
  if (!value) throw new Error('SlotHashes sysvar not found');
  return parseSlotHashes(new Uint8Array(Buffer.from(value.data[0], 'base64')));
}

function showVerify(body: any): void {
  for (const reason of body.reasons ?? []) console.log(`    · ${reason}`);
  console.log(body.passes ? green('    → passes (this cheat was NOT caught)') : red('    → does not pass: no bonus for this photo'));
}

/** Words from a slot that has aged past the check-in window, then a check-in with them. */
async function late(payer: Address) {
  console.log(bold('\n1. Late photo: words from minutes ago, sealed now'));
  const teacher = await cheater(payer);
  const { body: cfg } = await api('/config');
  const window = BigInt(cfg.windowSlots);
  let stale;
  for (let waited = 0; !stale; waited++) {
    const entries = await slotHashes();
    stale = entries.find((e) => entries[0].slot - e.slot > window + 10n);
    if (!stale) {
      if (waited === 0) console.log('    (chain is younger than the window; waiting for an old enough slot)');
      if (waited > 240) throw new Error('no slot old enough in SlotHashes');
      await sleep(1000);
    }
  }
  const day = dayNumber();
  const me = addressBytes(teacher.address);
  const { words } = challenge(stale.hash, me, prevFor(me, day, null), LANG);
  const ageS = Math.round((Number((await slotHashes())[0].slot - stale.slot) * cfg.slotMs) / 1000);
  console.log(`    words "${words.join(' · ')}" appeared ~${ageS} s ago (window ${Math.round((Number(window) * cfg.slotMs) / 1000)} s)`);
  const file = join(OUT, 'late.jpg');
  images('classroom', file, ...words);
  const ix = await getCheckInInstruction({
    programAddress: deploy.programId,
    payer,
    teacher,
    day,
    slot: stale.slot,
    photoHash: photoHash(readFileSync(file)),
  });
  const res = await relayTx([ix], payer);
  if (res.status === 200) console.log(green('    → accepted (this cheat was NOT caught)'));
  else console.log(red(`    → rejected by the Solana program: "${res.body.error}" (error ${res.body.code})`));
}

/** Check in with fresh words, then submit a class photo as if shot off a laptop screen. */
async function photoCheat(payer: Address, kind: 'screen' | 'edited') {
  const title = kind === 'screen'
    ? '2. Photo of a screen: fresh words, but the photo is of a laptop'
    : "3. Edited old photo: last week's class photo with today's words pasted on";
  console.log(bold(`\n${title}`));
  const teacher = await cheater(payer);
  const day = dayNumber();
  const me = addressBytes(teacher.address);
  const { slot, hash } = await freshSlot();
  const { words } = challenge(hash, me, prevFor(me, day, null), LANG);
  console.log(`    today's words: "${words.join(' · ')}"`);
  const file = join(OUT, `${kind}.jpg`);
  if (kind === 'screen') {
    const clean = join(OUT, 'screen-source.jpg');
    images('classroom', clean, ...words);
    images('screen', clean, file);
  } else {
    if (!existsSync(OLD_PHOTO)) throw new Error('no old photo yet; run scripts/demo.sh (it seeds one)');
    images('edit', OLD_PHOTO, file, ...words);
  }
  const image = readFileSync(file);
  const ix = await getCheckInInstruction({ programAddress: deploy.programId, payer, teacher, day, slot, photoHash: photoHash(image) });
  const res = await relayTx([ix], payer);
  if (res.status !== 200) throw new Error(`check-in failed: ${JSON.stringify(res.body)}`);
  console.log('    the words are fresh, so the program accepts the commitment; now the photo check:');
  const v = await verify(teacher.address, day, 0, image);
  if (v.status !== 200) throw new Error(`verify failed: ${JSON.stringify(v.body)}`);
  showVerify(v.body);
  console.log(`    proof page: ${proofUrl(teacher.address)}`);
}

/** Put an "earlier day's" class photo in the reuse index, as if it had been verified last week. */
async function seed() {
  mkdirSync(OUT, { recursive: true });
  if (!existsSync(OLD_PHOTO)) images('classroom', OLD_PHOTO, 'sun', 'kite', 'owl');
  const form = new FormData();
  form.set('image', new Blob([new Uint8Array(readFileSync(OLD_PHOTO))], { type: 'image/jpeg' }), 'old.jpg');
  form.set('expected', JSON.stringify(['sun', 'kite', 'owl']));
  form.set('prior', '[]');
  form.set('photo_id', 'archive:old-class-photo');
  form.set('group_id', 'archive');
  form.set('lang', LANG);
  const res = await fetch(`${VISION}/verify`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`seeding the old photo failed: ${res.status} ${await res.text()}`);
  const body: any = await res.json();
  const source = OLD_PHOTO === TEAM_OLD_PHOTO ? 'demo/old-class-photo.jpg' : 'a synthetic class photo';
  console.log(`seeded "last week's photo" (${source}) into the reuse index · vision engine: ${body.engine}`);
}

/** The most recent real (non-cheater) teacher check-in, by challenge slot. */
async function projector() {
  const accounts = await rpc
    .getProgramAccounts(address(deploy.programId), { encoding: 'base64', commitment: 'confirmed', filters: [{ dataSize: 736n }] })
    .send();
  let best: { teacher: Address; day: number; slot: bigint } | null = null;
  for (const { account } of accounts) {
    const d = decodeDay(new Uint8Array(Buffer.from(account.data[0], 'base64')));
    const last = d.links.at(-1);
    if (!last || (best && last.slot <= best.slot)) continue;
    const [teacherPda] = await findTeacherPda(address(deploy.programId), d.teacher);
    const info = await rpc.getAccountInfo(teacherPda, { encoding: 'base64', commitment: 'confirmed' }).send();
    if (!info.value || decodeTeacher(new Uint8Array(Buffer.from(info.value.data[0], 'base64'))).schoolId === CHEATER_SCHOOL) continue;
    best = { teacher: d.teacher, day: d.day, slot: last.slot };
  }
  if (!best) return console.log('no real teacher has checked in yet; check in from the phone first');
  const url = proofUrl(best.teacher, best.day).replace(APP_URL, 'https://localhost:5173');
  console.log(`opening ${url}`);
  if (process.platform === 'darwin') execFileSync('open', [url]);
}

async function main() {
  const [cmd = 'all', arg] = process.argv.slice(2);
  mkdirSync(OUT, { recursive: true });
  if (cmd === 'qr') {
    if (!arg) throw new Error('usage: demo qr <url>');
    qrcode.generate(arg, { small: true });
    return;
  }
  if (cmd === 'seed') return seed();
  if (cmd === 'projector') return projector();
  const payer = await relayer();
  if (cmd === 'late' || cmd === 'all') await late(payer);
  if (cmd === 'screen' || cmd === 'all') await photoCheat(payer, 'screen');
  if (cmd === 'edited' || cmd === 'all') await photoCheat(payer, 'edited');
  if (!['late', 'screen', 'edited', 'all'].includes(cmd)) throw new Error(`unknown command "${cmd}"`);
}

main().catch((e) => {
  console.error(red(e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
