import {
  configFromJson,
  getCheckInInstruction,
  getRecheckInInstruction,
  getRegisterTeacherInstruction,
  type ConfigAccount,
  type Lang,
} from '@chalk/shared';
import { address, type Address, type Instruction, type KeyPairSigner } from '@solana/kit';
import { api, ApiError, type Health } from './api.ts';
import { DEFAULT_SLOT_MS, num, type NextLink } from './logic.ts';
import { buildRelayTx } from './tx.ts';

export interface Ctx {
  signer: KeyPairSigner;
  wallet: Address;
  health: Health;
  programId: Address;
  relayer: Address;
  /** null until the admin has run init-config */
  config: ConfigAccount | null;
  slotMs: number;
  lang: Lang;
  dayNum: number;
}

export async function loadBackend(): Promise<Pick<Ctx, 'health' | 'programId' | 'relayer' | 'config' | 'slotMs'>> {
  const health = await api.health();
  const cfg = await api.config().catch((e) => {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  });
  return {
    health,
    programId: address(health.programId),
    relayer: address(health.relayer),
    config: cfg ? configFromJson(cfg) : null,
    slotMs: num(cfg?.slotMs, DEFAULT_SLOT_MS) || DEFAULT_SLOT_MS,
  };
}

async function relay(ctx: Ctx, ix: Instruction) {
  const lifetime = await api.blockhash();
  return api.relay(await buildRelayTx([ix], ctx.relayer, lifetime));
}

export async function registerTeacher(ctx: Ctx, schoolId: number) {
  if (await api.teacher(ctx.wallet)) return null;
  const ix = await getRegisterTeacherInstruction({
    programAddress: ctx.programId,
    payer: ctx.relayer,
    teacher: ctx.signer,
    schoolId,
  });
  return relay(ctx, ix);
}

/** Commits the photo hash for the next link: check_in for link 0, recheck_in after that. */
export async function sendLink(ctx: Ctx, next: NextLink, slot: number, photoHash: Uint8Array) {
  const common = { programAddress: ctx.programId, teacher: ctx.signer, day: ctx.dayNum, slot: BigInt(slot), photoHash };
  const ix =
    next.kind === 'check_in'
      ? await getCheckInInstruction({ ...common, payer: ctx.relayer })
      : await getRecheckInInstruction(common);
  return relay(ctx, ix);
}
