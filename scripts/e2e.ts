/**
 * End-to-end check against a running validator + backend + vision (mock).
 * Acts exactly like the app: teacher key signs, relayer pays via POST /relay.
 *
 *   scripts/setup-localnet.sh && scripts/dev.sh --bg --no-app
 *   pnpm --filter @chalk/scripts e2e        (BACKEND=http://127.0.0.1:8787 by default)
 */
import { execFileSync } from 'node:child_process';
import {
  address,
  generateKeyPairSigner,
  AccountRole,
  type Address,
  type Instruction,
} from '@solana/kit';
import {
  ERROR_CODES,
  PASS_MASK,
  SYSTEM_PROGRAM_ADDRESS,
  dayNumber,
  getCheckInInstruction,
  getRegisterTeacherInstruction,
  photoHash,
} from '@chalk/shared';

import {
  ROOT,
  deploy,
  sleep,
  rnd,
  api,
  post,
  relayTx,
  verify,
  getDay,
  usdcBalance,
  register,
  commitLink,
} from './client.ts';

let passed = 0;
function ok(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`FAILED: ${what}`);
  passed++;
  console.log(`  ok  ${what}`);
}
const step = (s: string) => console.log(`\n== ${s}`);

// ---- run ----

async function main() {
  const t0 = Date.now();
  step('backend + chain');
  const health = await api('/health');
  ok(health.status === 200 && health.body.ok, `GET /health ok (program ${health.body.programId})`);
  const relayer = address(health.body.relayer);
  const vision = await fetch('http://127.0.0.1:8001/health').then((r) => r.json()).catch(() => null);
  ok(vision?.ok, `vision up (engine ${vision?.engine})`);
  // The checks below rely on the mock engine's fixed answers (head count, no recapture).
  ok(vision?.engine === 'mock', 'vision is in mock mode (restart with CHALK_VISION_MODE=mock scripts/dev.sh --bg --no-app)');
  const { body: config } = await api('/config');
  const windowSlots = BigInt(config.windowSlots);
  const bonus = BigInt(config.bonusPerLink);
  console.log(`  window ${windowSlots} slots, bonus ${bonus} base units, slot ${config.slotMs} ms`);
  const day = dayNumber();

  // ---------- happy path ----------
  step('teacher A: register');
  const teacherA = await generateKeyPairSigner();
  const reg = await register(teacherA, relayer, 4242);
  ok(reg.status === 200 && reg.body.signature, `register_teacher via /relay (${reg.status})`);
  const t = await api(`/teacher/${teacherA.address}`);
  ok(t.status === 200 && t.body.schoolId === 4242, 'GET /teacher shows school 4242');

  step('teacher A: check_in (link 0)');
  const link0 = await commitLink({ teacher: teacherA, relayer, day, lastCommit: null, seed: rnd() });
  console.log(`  words: ${link0.words.join(' ')}`);
  ok(link0.res.status === 200 && link0.res.body.signature, `check_in relayed (slotAge ${link0.res.body.slotAge})`);
  ok(BigInt(link0.res.body.slotAge ?? 999999) <= windowSlots, 'slotAge within window_slots');
  let d = await getDay(teacherA.address, day);
  ok(d.day.nLinks === 1, 'Day account has 1 link');
  ok(
    JSON.stringify(d.json.links[0]!.wordsText) === JSON.stringify(link0.words),
    'on-chain words == words the teacher derived',
  );

  step('teacher A: verify link 0');
  const v0 = await verify(teacherA.address, day, 0, link0.image);
  ok(v0.status === 200, `POST /verify 200 (${v0.status} ${v0.status !== 200 ? JSON.stringify(v0.body) : ''})`);
  ok(v0.body.passes === true && (v0.body.flags & PASS_MASK) === PASS_MASK, `link 0 attested + passes (flags 0x${v0.body.flags.toString(16)})`);
  d = await getDay(teacherA.address, day);
  ok(d.day.links[0]!.passes && d.day.links[0]!.headcount === v0.body.headcount, 'on-chain link 0 flags/headcount match');

  step('teacher A: re-check');
  const rc = await post('/recheck', { teacher: teacherA.address, day });
  ok(rc.status === 200 && rc.body.fromSlot, `trigger_recheck (from ${rc.body.fromSlot} deadline ${rc.body.deadlineSlot})`);
  d = await getDay(teacherA.address, day);
  ok(d.day.recheckPending, 'Day.recheckPending = true');
  const link1 = await commitLink({
    teacher: teacherA,
    relayer,
    day,
    lastCommit: d.day.links[0]!.commit,
    minSlot: BigInt(rc.body.fromSlot),
    seed: rnd(),
  });
  console.log(`  words: ${link1.words.join(' ')}`);
  ok(link1.res.status === 200, `recheck_in relayed (${link1.res.status} ${link1.res.status !== 200 ? JSON.stringify(link1.res.body) : ''})`);
  d = await getDay(teacherA.address, day);
  ok(d.day.nLinks === 2 && !d.day.recheckPending && d.day.rechecksMet === 1, 'Day has 2 links, re-check met');
  ok(JSON.stringify(d.json.links[1]!.wordsText) === JSON.stringify(link1.words), 'link 1 words chain from link 0 commit');

  const v1 = await verify(teacherA.address, day, 1, link1.image);
  ok(v1.status === 200 && v1.body.passes === true, `link 1 attested + passes (flags 0x${v1.body.flags?.toString(16)})`);
  ok(JSON.stringify(v1.body.prior) === JSON.stringify([link0.words]), 'vision got link 0 words as prior');

  step('teacher A: settle');
  const before = await usdcBalance(teacherA.address);
  const st = await post('/settle', { teacher: teacherA.address, day });
  ok(st.status === 200, `settle_day (${st.status} ${st.status !== 200 ? JSON.stringify(st.body) : ''})`);
  ok(BigInt(st.body.amount) === 2n * bonus, `settle amount = 2 x bonus (${st.body.amount})`);
  const after = await usdcBalance(teacherA.address);
  ok(after - before === 2n * bonus, `teacher USDC balance +${after - before} base units`);
  d = await getDay(teacherA.address, day);
  ok(d.day.settled && d.day.paid === 2n * bonus, 'Day settled, paid recorded');
  const again = await post('/settle', { teacher: teacherA.address, day });
  ok(again.status >= 400 && again.body.code === ERROR_CODES.AlreadySettled, `second settle refused: "${again.body.error}"`);

  // ---------- negative cases ----------
  step('teacher B: stale slot -> SlotTooOld');
  const teacherB = await generateKeyPairSigner();
  ok((await register(teacherB, relayer, 7)).status === 200, 'teacher B registered');
  let current = BigInt((await api('/slot')).body.currentSlot);
  if (current <= windowSlots + 20n) {
    console.log(`  (fresh chain at slot ${current}; waiting until slot ${windowSlots + 21n} so a stale slot exists)`);
    while (current <= windowSlots + 20n) {
      await sleep(2000);
      current = BigInt((await api('/slot')).body.currentSlot);
    }
  }
  const stale = current - windowSlots - 20n;
  const staleIx = await getCheckInInstruction({
    programAddress: deploy.programId,
    payer: relayer,
    teacher: teacherB,
    day,
    slot: stale,
    photoHash: photoHash(link0.image),
  });
  const staleRes = await relayTx([staleIx], relayer);
  ok(
    staleRes.status === 400 && staleRes.body.code === ERROR_CODES.SlotTooOld,
    `check_in at slot ${stale} (now ${current}) rejected with ${staleRes.body.code}: "${staleRes.body.error}"`,
  );

  step('teacher B: same image bytes as teacher A -> reuse');
  const reused = await commitLink({ teacher: teacherB, relayer, day, lastCommit: null, image: link0.image, seed: rnd() });
  ok(reused.res.status === 200, 'teacher B check_in with A\'s photo lands on-chain (hash is just a commitment)');
  const vr = await verify(teacherB.address, day, 0, link0.image);
  ok(vr.status === 200 && vr.body.reuse?.is_reuse === true, `vision flags reuse (match ${vr.body.reuse?.match_id}, exact ${vr.body.reuse?.exact_duplicate})`);
  ok(vr.body.passes === false && (vr.body.flags & 8) === 0, `link fails: NOT_REUSED bit clear (flags 0x${vr.body.flags.toString(16)})`);
  const stB = await post('/settle', { teacher: teacherB.address, day });
  ok(stB.status === 200 && BigInt(stB.body.amount) === 0n, 'teacher B settles for 0');

  step('relay policy: foreign program / drain attempt');
  const teacherC = await generateKeyPairSigner();
  const drain: Instruction = {
    programAddress: SYSTEM_PROGRAM_ADDRESS,
    accounts: [
      { address: relayer, role: AccountRole.WRITABLE_SIGNER },
      { address: teacherC.address, role: AccountRole.WRITABLE },
    ],
    data: (() => {
      const b = new Uint8Array(12);
      const v = new DataView(b.buffer);
      v.setUint32(0, 2, true);
      v.setBigUint64(4, 1_000_000_000n, true);
      return b;
    })(),
  };
  const regC = await getRegisterTeacherInstruction({ programAddress: deploy.programId, payer: relayer, teacher: teacherC, schoolId: 1 });
  const drainRes = await relayTx([regC, drain], relayer);
  ok(drainRes.status >= 400 && !drainRes.body.signature, `system transfer from relayer refused (${drainRes.status}): "${drainRes.body.error}"`);
  const memo: Instruction = {
    programAddress: address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
    accounts: [{ address: teacherC.address, role: AccountRole.READONLY_SIGNER, signer: teacherC } as any],
    data: new TextEncoder().encode('hi'),
  };
  const memoRes = await relayTx([regC, memo], relayer);
  ok(memoRes.status >= 400 && !memoRes.body.signature, `foreign program (memo) refused (${memoRes.status}): "${memoRes.body.error}"`);
  const tC = await api(`/teacher/${teacherC.address}`);
  ok(tC.status === 404, 'nothing from the refused transactions landed');

  if (process.env.E2E_ROLL !== '0') await rollSection(relayer, day, config);

  console.log(`\nALL ${passed} CHECKS PASSED in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

function admin(...args: string[]) {
  execFileSync('pnpm', ['--silent', '--filter', 'backend', 'admin', ...args], { cwd: ROOT, stdio: 'pipe' });
}

/** roll_recheck: temporarily a 20-slot boundary and threshold 255 (≈ always hit), then restore. */
async function rollSection(relayer: Address, day: number, config: any) {
  step('roll_recheck (interval 20, threshold 255; restored afterwards)');
  admin('update-config', '--recheck-interval-slots', '20', '--recheck-threshold', '255');
  try {
    const teacherD = await generateKeyPairSigner();
    ok((await register(teacherD, relayer, 9)).status === 200, 'teacher D registered');
    const l0 = await commitLink({ teacher: teacherD, relayer, day, lastCommit: null, seed: rnd() });
    ok(l0.res.status === 200, 'teacher D check_in');
    let roll: any;
    for (let i = 0; i < 80; i++) {
      roll = await post('/roll', { teacher: teacherD.address, day });
      if (roll.status !== 409 || roll.body.code) break;
      await sleep(500);
    }
    ok(roll.status === 200 && roll.body.hit === true, `/roll at boundary ${roll.body.boundarySlot} hit (roll byte ${roll.body.roll})`);
    const d = await getDay(teacherD.address, day);
    ok(d.day.recheckPending && d.day.recheckFromSlot === BigInt(roll.body.boundarySlot), 'rolled re-check opens at the boundary slot');
    const again = await post('/roll', { teacher: teacherD.address, day });
    ok(again.status === 409, 'second /roll refused while the re-check is open');
    const l1 = await commitLink({
      teacher: teacherD,
      relayer,
      day,
      lastCommit: d.day.links[0]!.commit,
      minSlot: d.day.recheckFromSlot,
      seed: rnd(),
    });
    ok(l1.res.status === 200, 'recheck_in answers the rolled re-check');
  } finally {
    admin(
      'update-config',
      '--recheck-interval-slots',
      String(config.recheckIntervalSlots),
      '--recheck-threshold',
      String(config.recheckThreshold),
    );
    const { body } = await api('/config');
    ok(
      body.recheckIntervalSlots === String(config.recheckIntervalSlots) && body.recheckThreshold === config.recheckThreshold,
      'config restored',
    );
  }
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`);
  console.error(`(${passed} checks passed before the failure)`);
  process.exit(1);
});
