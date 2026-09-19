import { createHash } from 'node:crypto';
import {
  AccountRole,
  address,
  createNoopSigner,
  getSolanaErrorFromTransactionError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SolanaError,
  type Address,
} from '@solana/kit';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_DISCRIMINATORS,
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  ATTESTED,
  CONFIG_SIZE,
  DAY_SIZE,
  decodeConfig,
  decodeDay,
  decodeEvent,
  decodeTeacher,
  encodeConfig,
  encodeDay,
  encodeTeacher,
  ERROR_CODES,
  EVENT_DISCRIMINATORS,
  extractChalkError,
  extractCustomErrorCode,
  findAssociatedTokenAddress,
  findConfigPda,
  findDayPda,
  findTeacherPda,
  findVaultAta,
  findVaultAuthorityPda,
  flagsFrom,
  friendlyErrorMessage,
  getAttestInstruction,
  getCheckInInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitConfigInstruction,
  getRecheckInInstruction,
  getRegisterTeacherInstruction,
  getRollRecheckInstruction,
  getSettleDayInstruction,
  getTriggerRecheckInstruction,
  getUpdateConfigInstruction,
  identifyAccount,
  identifyInstruction,
  INSTRUCTION_DATA_SIZES,
  INSTRUCTION_DISCRIMINATORS,
  INSTRUCTION_NAMES,
  PASS_MASK,
  parseEventsFromLogs,
  projectedPayout,
  SYSTEM_PROGRAM_ADDRESS,
  SYSVAR_SLOT_HASHES_ADDRESS,
  TEACHER_SIZE,
  TOKEN_PROGRAM_ADDRESS,
  toBase64,
  toHex,
  type ChalkInstruction,
  type ConfigAccount,
  type ConfigArgs,
  type DayInput,
  type TeacherAccount,
} from '../src/index.ts';

const nodeSha = (s: string) => createHash('sha256').update(s).digest().subarray(0, 8).toString('hex');

// Reference PDAs computed independently with `solana find-program-derived-address` (Solana CLI 3.1.10).
const PROGRAM = address('5QfoP2K5HQWgmwA4YVNW8uMTccx4XHd3uFk7Ajg2xUJG');
const TEACHER = address('So11111111111111111111111111111111111111112');
const MINT = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const REF = {
  config: ['4txrVhcUNpTChEG1r9Bot4xasV6PNEzor1Y49MoqkT5Q', 253],
  vault: ['i7UB3DXyjbYCUWxstNxy4XG4yi7677Sh7yyt88BtG9f', 255],
  teacher: ['GH821DpwhP5uxnaxX24ubFN3NLkHPia1uLPxXMsr6E1h', 252],
  day20715: ['7wEH93zkkTQmgFCyC1WDLr59Y25rfz1ZvUyCbMrW4Lpy', 255],
  vaultAta: ['FGGHZyhTeGtiU2H82kUAU5Zj8sTiJ1jbCHtcL6oAfTFL', 255],
  teacherAta: ['DHe62eeQVEnNK7vg5xUpDkJm7tuqHadjhvmPRFBG9UPo', 254],
} as const;

const ADMIN = address('Stake11111111111111111111111111111111111111');
const ORACLE = address('Vote111111111111111111111111111111111111111');
const RELAYER = address('Config1111111111111111111111111111111111111');

const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill);

describe('discriminators', () => {
  it('instructions = sha256("global:<name>")[0..8]', () => {
    for (const n of INSTRUCTION_NAMES) expect(toHex(INSTRUCTION_DISCRIMINATORS[n])).toBe(nodeSha(`global:${n}`));
  });
  it('accounts = sha256("account:<Name>")[0..8]', () => {
    for (const n of ['Config', 'Teacher', 'Day'] as const)
      expect(toHex(ACCOUNT_DISCRIMINATORS[n])).toBe(nodeSha(`account:${n}`));
  });
  it('events = sha256("event:<Name>")[0..8]', () => {
    expect(toHex(EVENT_DISCRIMINATORS.CheckedIn)).toBe(nodeSha('event:CheckedIn'));
    expect(toHex(EVENT_DISCRIMINATORS.Settled)).toBe(nodeSha('event:Settled'));
  });
});

describe('PDAs (checked against solana CLI)', () => {
  it('config, vault, teacher, day, ATAs', async () => {
    expect(await findConfigPda(PROGRAM)).toEqual(REF.config);
    expect(await findVaultAuthorityPda(PROGRAM)).toEqual(REF.vault);
    expect(await findTeacherPda(PROGRAM, TEACHER)).toEqual(REF.teacher);
    expect(await findDayPda(PROGRAM, TEACHER, 20715)).toEqual(REF.day20715);
    expect(await findVaultAta(PROGRAM, MINT)).toEqual(REF.vaultAta);
    expect(await findAssociatedTokenAddress(TEACHER, MINT)).toEqual(REF.teacherAta);
  });
});

describe('account codecs', () => {
  const config: ConfigAccount = {
    admin: ADMIN,
    oracle: ORACLE,
    usdcMint: MINT,
    windowSlots: 225n,
    recheckWindowSlots: 1500n,
    recheckIntervalSlots: 750n,
    bonusPerLink: 250_000n,
    recheckThreshold: 64,
    maxLinks: 6,
    minHeadcount: 3,
    bump: 253,
    vaultBump: 255,
  };
  const teacher: TeacherAccount = {
    wallet: TEACHER,
    schoolId: 0xdeadbeef,
    daysSettled: 7,
    totalPaid: (1n << 64n) - 1n,
    bump: 252,
  };
  const passFlags = PASS_MASK;
  const day: DayInput = {
    teacher: TEACHER,
    day: 20715,
    nLinks: 2,
    recheckPending: true,
    rechecksMet: 1,
    missedRecheck: false,
    settled: false,
    bump: 255,
    recheckFromSlot: 1000n,
    recheckDeadlineSlot: 2500n,
    lastRolledBoundary: 750n,
    paid: 0n,
    links: [
      {
        slot: 900n,
        photoHash: bytes(32, 1),
        seed: bytes(32, 2),
        commit: bytes(32, 3),
        words: [82, 43, 28],
        flags: passFlags,
        headcount: 17,
      },
      {
        slot: 1010n,
        photoHash: bytes(32, 4),
        seed: bytes(32, 5),
        commit: bytes(32, 6),
        words: [255, 0, 7],
        flags: ATTESTED | 1,
        headcount: 0,
      },
    ],
  };

  it('Config round-trips at 141 bytes', () => {
    const data = encodeConfig(config);
    expect(data.length).toBe(CONFIG_SIZE);
    expect(CONFIG_SIZE).toBe(141);
    expect(decodeConfig(data)).toEqual(config);
    expect(identifyAccount(data)).toBe('Config');
  });

  it('Teacher round-trips at 57 bytes', () => {
    const data = encodeTeacher(teacher);
    expect(data.length).toBe(TEACHER_SIZE);
    expect(TEACHER_SIZE).toBe(57);
    expect(decodeTeacher(data)).toEqual(teacher);
  });

  it('Day round-trips at 736 bytes with links sliced to n_links and passes computed', () => {
    const data = encodeDay(day);
    expect(data.length).toBe(DAY_SIZE);
    expect(DAY_SIZE).toBe(736);
    const d = decodeDay(data);
    expect(d.links).toHaveLength(2);
    expect(d.links.map((l) => l.passes)).toEqual([true, false]);
    expect(d).toEqual({ ...day, links: day.links.map((l, i) => ({ ...l, passes: i === 0 })) });
    expect(encodeDay(d)).toEqual(data);
    expect(projectedPayout(d, 250_000n)).toEqual({ passing: 1, amount: 250_000n, willMissRecheck: false });
  });

  it('Day field offsets match the spec layout', () => {
    const data = encodeDay(day);
    const v = new DataView(data.buffer);
    expect(v.getUint32(40, true)).toBe(20715); // 8 disc + 32 teacher
    expect(data[44]).toBe(2); // n_links
    expect(data[45]).toBe(1); // recheck_pending
    expect(v.getBigUint64(50, true)).toBe(1000n); // recheck_from_slot
    expect(v.getBigUint64(74, true)).toBe(0n); // paid
    const link0 = 82;
    expect(v.getBigUint64(link0, true)).toBe(900n);
    expect(Array.from(data.subarray(link0 + 104, link0 + 109))).toEqual([82, 43, 28, passFlags, 17]);
    expect(v.getBigUint64(link0 + 109, true)).toBe(1010n);
  });

  it('rejects wrong size or discriminator', () => {
    expect(() => decodeConfig(encodeTeacher(teacher))).toThrow();
    const bad = encodeTeacher(teacher);
    bad[0]! ^= 1;
    expect(() => decodeTeacher(bad)).toThrow(/discriminator/);
    expect(() => decodeDay(encodeDay(day).subarray(0, 700))).toThrow(/736/);
  });
});

type Role = AccountRole;
const W = AccountRole.WRITABLE;
const R = AccountRole.READONLY;
const WS = AccountRole.WRITABLE_SIGNER;
const RS = AccountRole.READONLY_SIGNER;

function shape(ix: ChalkInstruction): [Address, Role][] {
  return ix.accounts.map((a) => [a.address, a.role]);
}

describe('instruction builders (SPEC §2.3 order and roles)', () => {
  const args: ConfigArgs = {
    oracle: ORACLE,
    windowSlots: 225n,
    recheckWindowSlots: 1500n,
    recheckIntervalSlots: 750n,
    bonusPerLink: 250_000n,
    recheckThreshold: 64,
    maxLinks: 6,
    minHeadcount: 3,
  };
  const photoHash = bytes(32, 9);
  const [config, , teacherPda, dayPda, vaultAta, teacherAta] = [
    REF.config[0],
    REF.vault[0],
    REF.teacher[0],
    REF.day20715[0],
    REF.vaultAta[0],
    REF.teacherAta[0],
  ].map((a) => address(a));
  const vault = address(REF.vault[0]);

  function check(ix: ChalkInstruction, name: (typeof INSTRUCTION_NAMES)[number], expected: [Address, Role][]) {
    expect(ix.programAddress).toBe(PROGRAM);
    expect(shape(ix)).toEqual(expected);
    expect(ix.data.length).toBe(INSTRUCTION_DATA_SIZES[name]);
    expect(identifyInstruction(ix.data)).toBe(name);
  }

  it('1 init_config', async () => {
    const ix = await getInitConfigInstruction({ programAddress: PROGRAM, admin: ADMIN, usdcMint: MINT, args });
    check(ix, 'init_config', [
      [ADMIN, WS],
      [config!, W],
      [vault, R],
      [MINT, R],
      [vaultAta!, W],
      [TOKEN_PROGRAM_ADDRESS, R],
      [ASSOCIATED_TOKEN_PROGRAM_ADDRESS, R],
      [SYSTEM_PROGRAM_ADDRESS, R],
    ]);
    expect(ix.data.length).toBe(75);
    const v = new DataView(ix.data.buffer);
    expect(v.getBigUint64(8 + 32, true)).toBe(225n);
    expect(v.getBigUint64(8 + 32 + 24, true)).toBe(250_000n);
    expect(Array.from(ix.data.subarray(72))).toEqual([64, 6, 3]);
  });

  it('2 update_config', async () => {
    const ix = await getUpdateConfigInstruction({ programAddress: PROGRAM, admin: ADMIN, args });
    check(ix, 'update_config', [
      [ADMIN, RS],
      [config!, W],
    ]);
  });

  it('3 register_teacher', async () => {
    const ix = await getRegisterTeacherInstruction({
      programAddress: PROGRAM,
      payer: RELAYER,
      teacher: TEACHER,
      schoolId: 42,
    });
    check(ix, 'register_teacher', [
      [RELAYER, WS],
      [TEACHER, RS],
      [teacherPda!, W],
      [SYSTEM_PROGRAM_ADDRESS, R],
    ]);
    expect(new DataView(ix.data.buffer).getUint32(8, true)).toBe(42);
  });

  it('4 check_in', async () => {
    const ix = await getCheckInInstruction({
      programAddress: PROGRAM,
      payer: RELAYER,
      teacher: TEACHER,
      day: 20715,
      slot: 123456789n,
      photoHash,
    });
    check(ix, 'check_in', [
      [RELAYER, WS],
      [TEACHER, RS],
      [config!, R],
      [teacherPda!, R],
      [dayPda!, W],
      [SYSVAR_SLOT_HASHES_ADDRESS, R],
      [SYSTEM_PROGRAM_ADDRESS, R],
    ]);
    const v = new DataView(ix.data.buffer);
    expect(v.getUint32(8, true)).toBe(20715);
    expect(v.getBigUint64(12, true)).toBe(123456789n);
    expect(ix.data.subarray(20)).toEqual(photoHash);
  });

  it('5 recheck_in', async () => {
    const ix = await getRecheckInInstruction({
      programAddress: PROGRAM,
      teacher: TEACHER,
      day: 20715,
      slot: 5,
      photoHash,
    });
    check(ix, 'recheck_in', [
      [TEACHER, RS],
      [config!, R],
      [dayPda!, W],
      [SYSVAR_SLOT_HASHES_ADDRESS, R],
    ]);
  });

  it('6 trigger_recheck', async () => {
    const ix = await getTriggerRecheckInstruction({ programAddress: PROGRAM, oracle: ORACLE, teacher: TEACHER, day: 20715 });
    check(ix, 'trigger_recheck', [
      [ORACLE, RS],
      [config!, R],
      [TEACHER, R],
      [dayPda!, W],
    ]);
  });

  it('7 roll_recheck', async () => {
    const ix = await getRollRecheckInstruction({
      programAddress: PROGRAM,
      cranker: RELAYER,
      teacher: TEACHER,
      day: 20715,
      boundarySlot: 1500n,
    });
    check(ix, 'roll_recheck', [
      [RELAYER, RS],
      [config!, R],
      [TEACHER, R],
      [dayPda!, W],
      [SYSVAR_SLOT_HASHES_ADDRESS, R],
    ]);
    expect(new DataView(ix.data.buffer).getBigUint64(12, true)).toBe(1500n);
  });

  it('8 attest', async () => {
    const flags = flagsFrom({ wordsOk: true, chainOk: true, notRecapture: true, notReused: true, peopleOk: true });
    const ix = await getAttestInstruction({
      programAddress: PROGRAM,
      oracle: ORACLE,
      teacher: TEACHER,
      day: 20715,
      idx: 1,
      flags,
      headcount: 23,
    });
    check(ix, 'attest', [
      [ORACLE, RS],
      [config!, R],
      [TEACHER, R],
      [dayPda!, W],
    ]);
    expect(Array.from(ix.data.subarray(12))).toEqual([1, 0b1_1111, 23]);
  });

  it('9 settle_day', async () => {
    const ix = await getSettleDayInstruction({
      programAddress: PROGRAM,
      oracle: ORACLE,
      teacher: TEACHER,
      day: 20715,
      usdcMint: MINT,
    });
    check(ix, 'settle_day', [
      [ORACLE, RS],
      [config!, R],
      [TEACHER, R],
      [teacherPda!, W],
      [dayPda!, W],
      [vault, R],
      [vaultAta!, W],
      [teacherAta!, W],
      [MINT, R],
      [TOKEN_PROGRAM_ADDRESS, R],
    ]);
  });

  it('attaches TransactionSigners when given instead of addresses', async () => {
    const teacherSigner = createNoopSigner(TEACHER);
    const ix = await getCheckInInstruction({
      programAddress: PROGRAM,
      payer: RELAYER,
      teacher: teacherSigner,
      day: 20715,
      slot: 1n,
      photoHash,
    });
    expect(ix.accounts[1]).toEqual({ address: TEACHER, role: RS, signer: teacherSigner });
    expect('signer' in ix.accounts[0]!).toBe(false);
    expect(ix.accounts[4]!.address).toBe(dayPda);
  });

  it('ATA CreateIdempotent', async () => {
    const ix = await getCreateAssociatedTokenIdempotentInstruction({ payer: ORACLE, owner: TEACHER, mint: MINT });
    expect(ix.programAddress).toBe(ASSOCIATED_TOKEN_PROGRAM_ADDRESS);
    expect(shape(ix)).toEqual([
      [ORACLE, WS],
      [teacherAta!, W],
      [TEACHER, R],
      [MINT, R],
      [SYSTEM_PROGRAM_ADDRESS, R],
      [TOKEN_PROGRAM_ADDRESS, R],
    ]);
    expect(Array.from(ix.data)).toEqual([1]);
  });

  it('rejects out-of-range args', async () => {
    await expect(
      getCheckInInstruction({ programAddress: PROGRAM, payer: RELAYER, teacher: TEACHER, day: -1, slot: 1, photoHash }),
    ).rejects.toThrow();
    await expect(
      getCheckInInstruction({
        programAddress: PROGRAM,
        payer: RELAYER,
        teacher: TEACHER,
        day: 1,
        slot: 1,
        photoHash: bytes(31, 0),
      }),
    ).rejects.toThrow();
  });
});

describe('errors', () => {
  it('codes are 6000.. in spec order', () => {
    expect(ERROR_CODES.SlotNotFound).toBe(6000);
    expect(ERROR_CODES.SlotTooOld).toBe(6001);
    expect(ERROR_CODES.InvalidConfig).toBe(6015);
  });

  it('extracts from a Kit preflight SolanaError', () => {
    const cause = getSolanaErrorFromTransactionError({ InstructionError: [0, { Custom: 6001 }] });
    const err = new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, {
      accounts: null,
      logs: [],
      returnData: null,
      unitsConsumed: 0n,
      cause,
    } as never);
    expect(extractCustomErrorCode(err)).toBe(6001);
    expect(friendlyErrorMessage(err)).toBe('Photo sent too late. Get new words and try again.');
  });

  it('extracts from raw err objects, simulation results, logs and strings', () => {
    expect(extractCustomErrorCode({ InstructionError: [1, { Custom: 6004 }] })).toBe(6004);
    expect(extractCustomErrorCode({ value: { err: { InstructionError: [0, { Custom: 6010n }] }, logs: [] } })).toBe(
      6010,
    );
    expect(
      extractCustomErrorCode({
        logs: [
          'Program X invoke [1]',
          'Program log: AnchorError occurred. Error Code: TooManyLinks. Error Number: 6005. Error Message: x.',
          'Program X failed: custom program error: 0x1775',
        ],
      }),
    ).toBe(6005);
    expect(extractCustomErrorCode(new Error('failed: custom program error: 0x1770'))).toBe(6000);
    expect(extractChalkError('custom program error: 0x177f')).toEqual({
      code: 6015,
      name: 'InvalidConfig',
      message: 'Invalid configuration.',
    });
    expect(extractCustomErrorCode(new Error('blockhash not found'))).toBeNull();
    expect(extractChalkError({ InstructionError: [0, { Custom: 1 }] })).toBeNull();
    expect(friendlyErrorMessage(null, 'x')).toBe('x');
  });
});

describe('events', () => {
  it('decodes a CheckedIn from Program data logs', () => {
    const body = new Uint8Array(8 + 32 + 4 + 1 + 8 + 8 + 3);
    body.set(EVENT_DISCRIMINATORS.CheckedIn, 0);
    body.set(bytes(32, 0), 8);
    const v = new DataView(body.buffer);
    v.setUint32(40, 20715, true);
    body[44] = 0;
    v.setBigUint64(45, 777n, true);
    v.setBigUint64(53, 12n, true);
    body.set([1, 2, 3], 61);
    const events = parseEventsFromLogs(['Program log: hi', `Program data: ${toBase64(body)}`, 'Program data: !!!']);
    expect(events).toEqual([
      {
        name: 'CheckedIn',
        teacher: SYSTEM_PROGRAM_ADDRESS,
        day: 20715,
        idx: 0,
        slot: 777n,
        slotAge: 12n,
        words: [1, 2, 3],
      },
    ]);
    expect(decodeEvent(new Uint8Array(8))).toBeNull();
  });
});

describe('projectedPayout and a re-check past its deadline', () => {
  const open = (over: Partial<DayInput> = {}): DayAccount =>
    decodeDay(
      encodeDay({
        teacher: TEACHER,
        day: 20715,
        nLinks: 1,
        recheckPending: true,
        rechecksMet: 0,
        missedRecheck: false,
        settled: false,
        bump: 255,
        recheckFromSlot: 100n,
        recheckDeadlineSlot: 500n,
        lastRolledBoundary: 0n,
        paid: 0n,
        links: [
          {
            slot: 90n,
            photoHash: bytes(32, 1),
            seed: bytes(32, 2),
            commit: bytes(32, 3),
            words: [1, 2, 3],
            flags: PASS_MASK,
            headcount: 7,
          },
        ],
        ...over,
      }),
    );

  it('promises the bonus while the re-check can still be answered', () => {
    expect(projectedPayout(open(), 600000n, 400n)).toEqual({ passing: 1, amount: 600000n, willMissRecheck: false });
  });

  it('promises nothing once the deadline has passed, as settle_day would', () => {
    expect(projectedPayout(open(), 600000n, 501n)).toEqual({ passing: 1, amount: 0n, willMissRecheck: true });
  });

  it('without a slot, keeps the old behaviour', () => {
    expect(projectedPayout(open(), 600000n).amount).toBe(600000n);
  });
});
