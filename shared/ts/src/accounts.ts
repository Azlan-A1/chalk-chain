import type { Address, ReadonlyUint8Array } from '@solana/kit';
import { BorshReader, BorshWriter } from './borsh.ts';
import { linkPasses, MAX_LINKS } from './constants.ts';
import { ACCOUNT_DISCRIMINATORS, startsWith, type AccountName } from './discriminators.ts';

// SPEC §2.2. Sizes include the 8-byte discriminator.
export const CONFIG_SIZE = 141;
export const TEACHER_SIZE = 57;
export const LINK_SIZE = 109;
export const DAY_SIZE = 736;

export interface ConfigAccount {
  admin: Address;
  oracle: Address;
  usdcMint: Address;
  windowSlots: bigint;
  recheckWindowSlots: bigint;
  recheckIntervalSlots: bigint;
  bonusPerLink: bigint;
  recheckThreshold: number;
  maxLinks: number;
  minHeadcount: number;
  bump: number;
  vaultBump: number;
}

export interface TeacherAccount {
  wallet: Address;
  schoolId: number;
  daysSettled: number;
  totalPaid: bigint;
  bump: number;
}

export type WordTriple = [number, number, number];

export interface LinkInput {
  slot: bigint;
  photoHash: Uint8Array;
  seed: Uint8Array;
  commit: Uint8Array;
  words: WordTriple;
  flags: number;
  headcount: number;
}

export interface Link extends LinkInput {
  /** flags & PASS_MASK == PASS_MASK */
  passes: boolean;
}

export interface DayAccount {
  teacher: Address;
  day: number;
  nLinks: number;
  recheckPending: boolean;
  rechecksMet: number;
  missedRecheck: boolean;
  settled: boolean;
  bump: number;
  recheckFromSlot: bigint;
  recheckDeadlineSlot: bigint;
  lastRolledBoundary: bigint;
  paid: bigint;
  /** Only the first nLinks stored links. */
  links: Link[];
}

export type DayInput = Omit<DayAccount, 'links'> & { links: readonly LinkInput[] };

function reader(data: ReadonlyUint8Array, name: AccountName, size: number): BorshReader {
  if (data.length !== size) throw new Error(`${name} account must be ${size} bytes, got ${data.length}`);
  if (!startsWith(data, ACCOUNT_DISCRIMINATORS[name])) throw new Error(`not a ${name} account (discriminator mismatch)`);
  const r = new BorshReader(data);
  r.off = 8;
  return r;
}

function writer(name: AccountName, size: number): BorshWriter {
  return new BorshWriter(size).bytes(ACCOUNT_DISCRIMINATORS[name], 8);
}

export function decodeConfig(data: ReadonlyUint8Array): ConfigAccount {
  const r = reader(data, 'Config', CONFIG_SIZE);
  return {
    admin: r.pubkey(),
    oracle: r.pubkey(),
    usdcMint: r.pubkey(),
    windowSlots: r.u64(),
    recheckWindowSlots: r.u64(),
    recheckIntervalSlots: r.u64(),
    bonusPerLink: r.u64(),
    recheckThreshold: r.u8(),
    maxLinks: r.u8(),
    minHeadcount: r.u8(),
    bump: r.u8(),
    vaultBump: r.u8(),
  };
}

export function encodeConfig(c: ConfigAccount): Uint8Array {
  return writer('Config', CONFIG_SIZE)
    .pubkey(c.admin)
    .pubkey(c.oracle)
    .pubkey(c.usdcMint)
    .u64(c.windowSlots)
    .u64(c.recheckWindowSlots)
    .u64(c.recheckIntervalSlots)
    .u64(c.bonusPerLink)
    .u8(c.recheckThreshold)
    .u8(c.maxLinks)
    .u8(c.minHeadcount)
    .u8(c.bump)
    .u8(c.vaultBump)
    .finish();
}

export function decodeTeacher(data: ReadonlyUint8Array): TeacherAccount {
  const r = reader(data, 'Teacher', TEACHER_SIZE);
  return {
    wallet: r.pubkey(),
    schoolId: r.u32(),
    daysSettled: r.u32(),
    totalPaid: r.u64(),
    bump: r.u8(),
  };
}

export function encodeTeacher(t: TeacherAccount): Uint8Array {
  return writer('Teacher', TEACHER_SIZE)
    .pubkey(t.wallet)
    .u32(t.schoolId)
    .u32(t.daysSettled)
    .u64(t.totalPaid)
    .u8(t.bump)
    .finish();
}

function readLink(r: BorshReader): Link {
  const slot = r.u64();
  const photoHash = r.bytes(32);
  const seed = r.bytes(32);
  const commit = r.bytes(32);
  const words: WordTriple = [r.u8(), r.u8(), r.u8()];
  const flags = r.u8();
  const headcount = r.u8();
  return { slot, photoHash, seed, commit, words, flags, headcount, passes: linkPasses(flags) };
}

const EMPTY_LINK: LinkInput = {
  slot: 0n,
  photoHash: new Uint8Array(32),
  seed: new Uint8Array(32),
  commit: new Uint8Array(32),
  words: [0, 0, 0],
  flags: 0,
  headcount: 0,
};

export function decodeDay(data: ReadonlyUint8Array): DayAccount {
  const r = reader(data, 'Day', DAY_SIZE);
  const head = {
    teacher: r.pubkey(),
    day: r.u32(),
    nLinks: r.u8(),
    recheckPending: r.bool(),
    rechecksMet: r.u8(),
    missedRecheck: r.bool(),
    settled: r.bool(),
    bump: r.u8(),
    recheckFromSlot: r.u64(),
    recheckDeadlineSlot: r.u64(),
    lastRolledBoundary: r.u64(),
    paid: r.u64(),
  };
  if (head.nLinks > MAX_LINKS) throw new Error(`Day.n_links ${head.nLinks} > ${MAX_LINKS}`);
  const all: Link[] = [];
  for (let i = 0; i < MAX_LINKS; i++) all.push(readLink(r));
  return { ...head, links: all.slice(0, head.nLinks) };
}

export function encodeDay(d: DayInput): Uint8Array {
  if (d.links.length > MAX_LINKS) throw new Error(`at most ${MAX_LINKS} links`);
  const w = writer('Day', DAY_SIZE)
    .pubkey(d.teacher)
    .u32(d.day)
    .u8(d.nLinks)
    .bool(d.recheckPending)
    .u8(d.rechecksMet)
    .bool(d.missedRecheck)
    .bool(d.settled)
    .u8(d.bump)
    .u64(d.recheckFromSlot)
    .u64(d.recheckDeadlineSlot)
    .u64(d.lastRolledBoundary)
    .u64(d.paid);
  for (let i = 0; i < MAX_LINKS; i++) {
    const l = d.links[i] ?? EMPTY_LINK;
    w.u64(l.slot).bytes(l.photoHash, 32).bytes(l.seed, 32).bytes(l.commit, 32);
    w.u8(l.words[0]).u8(l.words[1]).u8(l.words[2]).u8(l.flags).u8(l.headcount);
  }
  return w.finish();
}

/** Links that pass, and what settle_day would pay (SPEC §2.4).
 *
 * Pass `currentSlot` where it is known: settle_day marks a still-pending re-check past its
 * deadline as missed and pays nothing, so without it this over-promises a bonus. */
export function projectedPayout(
  day: DayAccount,
  bonusPerLink: bigint,
  currentSlot?: bigint | number,
): { passing: number; amount: bigint; willMissRecheck: boolean } {
  const passing = day.links.filter((l) => l.passes).length;
  const firstPasses = day.links[0]?.passes ?? false;
  const expired =
    day.recheckPending && currentSlot !== undefined && BigInt(currentSlot) > day.recheckDeadlineSlot;
  const willMissRecheck = day.missedRecheck || expired;
  const amount = firstPasses && !willMissRecheck ? BigInt(passing) * bonusPerLink : 0n;
  return { passing, amount, willMissRecheck };
}
