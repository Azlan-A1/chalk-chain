import {
  AccountRole,
  type AccountMeta,
  type AccountSignerMeta,
  type Address,
  type Instruction,
  type InstructionWithAccounts,
  type InstructionWithData,
  type ReadonlyUint8Array,
  type TransactionSigner,
} from '@solana/kit';
import { BorshWriter } from './borsh.ts';
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
  SYSVAR_SLOT_HASHES_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
} from './constants.ts';
import { INSTRUCTION_DISCRIMINATORS, type InstructionName } from './discriminators.ts';
import {
  findAssociatedTokenAddress,
  findConfigPda,
  findDayPda,
  findTeacherPda,
  findVaultAta,
  findVaultAuthorityPda,
} from './pda.ts';

// SPEC §2.3. Account order and roles here are the contract with the program.

export type AddressOrSigner = Address | TransactionSigner;
export type ChalkAccountMeta = AccountMeta | AccountSignerMeta;
export type ChalkInstruction = Instruction &
  InstructionWithAccounts<readonly ChalkAccountMeta[]> &
  InstructionWithData<Uint8Array>;

export interface ConfigArgs {
  oracle: Address;
  windowSlots: bigint;
  recheckWindowSlots: bigint;
  recheckIntervalSlots: bigint;
  bonusPerLink: bigint;
  recheckThreshold: number;
  maxLinks: number;
  minHeadcount: number;
}

export const CONFIG_ARGS_SIZE = 32 + 8 * 4 + 3;

/** Instruction data length (discriminator + args) per instruction. */
export const INSTRUCTION_DATA_SIZES: Readonly<Record<InstructionName, number>> = {
  init_config: 8 + CONFIG_ARGS_SIZE,
  update_config: 8 + CONFIG_ARGS_SIZE,
  register_teacher: 8 + 4,
  check_in: 8 + 4 + 8 + 32,
  recheck_in: 8 + 4 + 8 + 32,
  trigger_recheck: 8 + 4,
  roll_recheck: 8 + 4 + 8,
  attest: 8 + 4 + 1 + 1 + 1,
  settle_day: 8 + 4,
};

export function addressOf(x: AddressOrSigner): Address {
  return typeof x === 'string' ? x : x.address;
}

function signer(x: AddressOrSigner, writable: boolean): ChalkAccountMeta {
  const role = writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER;
  return typeof x === 'string' ? { address: x, role } : { address: x.address, role, signer: x };
}
const ro = (address: Address): AccountMeta => ({ address, role: AccountRole.READONLY });
const rw = (address: Address): AccountMeta => ({ address, role: AccountRole.WRITABLE });

function data(name: InstructionName, write?: (w: BorshWriter) => void): Uint8Array {
  const w = new BorshWriter(INSTRUCTION_DATA_SIZES[name]).bytes(INSTRUCTION_DISCRIMINATORS[name], 8);
  write?.(w);
  return w.finish();
}

function ix(programAddress: Address, accounts: ChalkAccountMeta[], bytes: Uint8Array): ChalkInstruction {
  return { programAddress, accounts, data: bytes };
}

// ---- instruction data encoders ----

function writeConfigArgs(w: BorshWriter, a: ConfigArgs): void {
  w.pubkey(a.oracle)
    .u64(a.windowSlots)
    .u64(a.recheckWindowSlots)
    .u64(a.recheckIntervalSlots)
    .u64(a.bonusPerLink)
    .u8(a.recheckThreshold)
    .u8(a.maxLinks)
    .u8(a.minHeadcount);
}

export const encodeInitConfigData = (args: ConfigArgs) => data('init_config', (w) => writeConfigArgs(w, args));
export const encodeUpdateConfigData = (args: ConfigArgs) => data('update_config', (w) => writeConfigArgs(w, args));
export const encodeRegisterTeacherData = (schoolId: number) => data('register_teacher', (w) => w.u32(schoolId));
export const encodeCheckInData = (day: number, slot: bigint | number, photoHash: ReadonlyUint8Array) =>
  data('check_in', (w) => w.u32(day).u64(slot).bytes(photoHash, 32));
export const encodeRecheckInData = (day: number, slot: bigint | number, photoHash: ReadonlyUint8Array) =>
  data('recheck_in', (w) => w.u32(day).u64(slot).bytes(photoHash, 32));
export const encodeTriggerRecheckData = (day: number) => data('trigger_recheck', (w) => w.u32(day));
export const encodeRollRecheckData = (day: number, boundarySlot: bigint | number) =>
  data('roll_recheck', (w) => w.u32(day).u64(boundarySlot));
export const encodeAttestData = (day: number, idx: number, flags: number, headcount: number) =>
  data('attest', (w) => w.u32(day).u8(idx).u8(flags).u8(headcount));
export const encodeSettleDayData = (day: number) => data('settle_day', (w) => w.u32(day));

// ---- builders (async because PDAs are derived) ----

/** 1. admin (w,s) · config (w) · vault_authority · usdc_mint · vault ATA (w) · token_program · associated_token_program · system_program */
export async function getInitConfigInstruction(input: {
  programAddress: Address;
  admin: AddressOrSigner;
  usdcMint: Address;
  args: ConfigArgs;
}): Promise<ChalkInstruction> {
  const { programAddress: p, usdcMint } = input;
  const [[config], [vaultAuthority], [vault]] = await Promise.all([
    findConfigPda(p),
    findVaultAuthorityPda(p),
    findVaultAta(p, usdcMint),
  ]);
  return ix(
    p,
    [
      signer(input.admin, true),
      rw(config),
      ro(vaultAuthority),
      ro(usdcMint),
      rw(vault),
      ro(TOKEN_PROGRAM_ADDRESS),
      ro(ASSOCIATED_TOKEN_PROGRAM_ADDRESS),
      ro(SYSTEM_PROGRAM_ADDRESS),
    ],
    encodeInitConfigData(input.args),
  );
}

/** 2. admin (s) · config (w) */
export async function getUpdateConfigInstruction(input: {
  programAddress: Address;
  admin: AddressOrSigner;
  args: ConfigArgs;
}): Promise<ChalkInstruction> {
  const [config] = await findConfigPda(input.programAddress);
  return ix(input.programAddress, [signer(input.admin, false), rw(config)], encodeUpdateConfigData(input.args));
}

/** 3. payer (w,s) · teacher (s) · teacher_account (w) · system_program */
export async function getRegisterTeacherInstruction(input: {
  programAddress: Address;
  payer: AddressOrSigner;
  teacher: AddressOrSigner;
  schoolId: number;
}): Promise<ChalkInstruction> {
  const [teacherAccount] = await findTeacherPda(input.programAddress, addressOf(input.teacher));
  return ix(
    input.programAddress,
    [signer(input.payer, true), signer(input.teacher, false), rw(teacherAccount), ro(SYSTEM_PROGRAM_ADDRESS)],
    encodeRegisterTeacherData(input.schoolId),
  );
}

/** 4. payer (w,s) · teacher (s) · config · teacher_account · day_account (w) · slot_hashes · system_program */
export async function getCheckInInstruction(input: {
  programAddress: Address;
  payer: AddressOrSigner;
  teacher: AddressOrSigner;
  day: number;
  slot: bigint | number;
  photoHash: ReadonlyUint8Array;
}): Promise<ChalkInstruction> {
  const p = input.programAddress;
  const teacher = addressOf(input.teacher);
  const [[config], [teacherAccount], [dayAccount]] = await Promise.all([
    findConfigPda(p),
    findTeacherPda(p, teacher),
    findDayPda(p, teacher, input.day),
  ]);
  return ix(
    p,
    [
      signer(input.payer, true),
      signer(input.teacher, false),
      ro(config),
      ro(teacherAccount),
      rw(dayAccount),
      ro(SYSVAR_SLOT_HASHES_ADDRESS),
      ro(SYSTEM_PROGRAM_ADDRESS),
    ],
    encodeCheckInData(input.day, input.slot, input.photoHash),
  );
}

/** 5. teacher (s) · config · day_account (w) · slot_hashes */
export async function getRecheckInInstruction(input: {
  programAddress: Address;
  teacher: AddressOrSigner;
  day: number;
  slot: bigint | number;
  photoHash: ReadonlyUint8Array;
}): Promise<ChalkInstruction> {
  const p = input.programAddress;
  const [[config], [dayAccount]] = await Promise.all([
    findConfigPda(p),
    findDayPda(p, addressOf(input.teacher), input.day),
  ]);
  return ix(
    p,
    [signer(input.teacher, false), ro(config), rw(dayAccount), ro(SYSVAR_SLOT_HASHES_ADDRESS)],
    encodeRecheckInData(input.day, input.slot, input.photoHash),
  );
}

/** 6. oracle (s) · config · teacher · day_account (w) */
export async function getTriggerRecheckInstruction(input: {
  programAddress: Address;
  oracle: AddressOrSigner;
  teacher: Address;
  day: number;
}): Promise<ChalkInstruction> {
  const p = input.programAddress;
  const [[config], [dayAccount]] = await Promise.all([findConfigPda(p), findDayPda(p, input.teacher, input.day)]);
  return ix(
    p,
    [signer(input.oracle, false), ro(config), ro(input.teacher), rw(dayAccount)],
    encodeTriggerRecheckData(input.day),
  );
}

/** 7. cranker (s) · config · teacher · day_account (w) · slot_hashes */
export async function getRollRecheckInstruction(input: {
  programAddress: Address;
  cranker: AddressOrSigner;
  teacher: Address;
  day: number;
  boundarySlot: bigint | number;
}): Promise<ChalkInstruction> {
  const p = input.programAddress;
  const [[config], [dayAccount]] = await Promise.all([findConfigPda(p), findDayPda(p, input.teacher, input.day)]);
  return ix(
    p,
    [signer(input.cranker, false), ro(config), ro(input.teacher), rw(dayAccount), ro(SYSVAR_SLOT_HASHES_ADDRESS)],
    encodeRollRecheckData(input.day, input.boundarySlot),
  );
}

/** 8. oracle (s) · config · teacher · day_account (w) */
export async function getAttestInstruction(input: {
  programAddress: Address;
  oracle: AddressOrSigner;
  teacher: Address;
  day: number;
  idx: number;
  flags: number;
  headcount: number;
}): Promise<ChalkInstruction> {
  const p = input.programAddress;
  const [[config], [dayAccount]] = await Promise.all([findConfigPda(p), findDayPda(p, input.teacher, input.day)]);
  return ix(
    p,
    [signer(input.oracle, false), ro(config), ro(input.teacher), rw(dayAccount)],
    encodeAttestData(input.day, input.idx, input.flags, Math.min(255, Math.max(0, Math.floor(input.headcount)))),
  );
}

/**
 * 9. oracle (s) · config · teacher · teacher_account (w) · day_account (w) · vault_authority · vault ATA (w)
 *    · teacher_usdc ATA (w) · usdc_mint · token_program
 * teacher_usdc must exist: put getCreateAssociatedTokenIdempotentInstruction before this.
 */
export async function getSettleDayInstruction(input: {
  programAddress: Address;
  oracle: AddressOrSigner;
  teacher: Address;
  day: number;
  usdcMint: Address;
}): Promise<ChalkInstruction> {
  const { programAddress: p, teacher, usdcMint } = input;
  const [[config], [teacherAccount], [dayAccount], [vaultAuthority], [vault], [teacherUsdc]] = await Promise.all([
    findConfigPda(p),
    findTeacherPda(p, teacher),
    findDayPda(p, teacher, input.day),
    findVaultAuthorityPda(p),
    findVaultAta(p, usdcMint),
    findAssociatedTokenAddress(teacher, usdcMint),
  ]);
  return ix(
    p,
    [
      signer(input.oracle, false),
      ro(config),
      ro(teacher),
      rw(teacherAccount),
      rw(dayAccount),
      ro(vaultAuthority),
      rw(vault),
      rw(teacherUsdc),
      ro(usdcMint),
      ro(TOKEN_PROGRAM_ADDRESS),
    ],
    encodeSettleDayData(input.day),
  );
}

/**
 * Associated Token Program CreateIdempotent (data = [1]) for owner's ATA of mint (classic token program).
 * payer (w,s) · ata (w) · owner · mint · system_program · token_program
 */
export async function getCreateAssociatedTokenIdempotentInstruction(input: {
  payer: AddressOrSigner;
  owner: Address;
  mint: Address;
}): Promise<ChalkInstruction> {
  const [ata] = await findAssociatedTokenAddress(input.owner, input.mint);
  return ix(
    ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    [
      signer(input.payer, true),
      rw(ata),
      ro(input.owner),
      ro(input.mint),
      ro(SYSTEM_PROGRAM_ADDRESS),
      ro(TOKEN_PROGRAM_ADDRESS),
    ],
    new Uint8Array([1]),
  );
}
