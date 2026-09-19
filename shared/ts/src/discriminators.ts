import type { ReadonlyUint8Array } from '@solana/kit';
import { sha256 } from './derive.ts';

const utf8 = (s: string) => new TextEncoder().encode(s);

/** Anchor default: sha256("global:<snake_name>")[0..8]. */
export function instructionDiscriminator(name: string): Uint8Array {
  return sha256(utf8(`global:${name}`)).slice(0, 8);
}

/** Anchor default: sha256("account:<StructName>")[0..8]. */
export function accountDiscriminator(name: string): Uint8Array {
  return sha256(utf8(`account:${name}`)).slice(0, 8);
}

/** Anchor default: sha256("event:<StructName>")[0..8]. */
export function eventDiscriminator(name: string): Uint8Array {
  return sha256(utf8(`event:${name}`)).slice(0, 8);
}

export const INSTRUCTION_NAMES = [
  'init_config',
  'update_config',
  'register_teacher',
  'check_in',
  'recheck_in',
  'trigger_recheck',
  'roll_recheck',
  'attest',
  'settle_day',
] as const;
export type InstructionName = (typeof INSTRUCTION_NAMES)[number];

export const ACCOUNT_NAMES = ['Config', 'Teacher', 'Day'] as const;
export type AccountName = (typeof ACCOUNT_NAMES)[number];

export const EVENT_NAMES = ['CheckedIn', 'RecheckStarted', 'RecheckRolled', 'Attested', 'Settled'] as const;
export type EventName = (typeof EVENT_NAMES)[number];

export const INSTRUCTION_DISCRIMINATORS = Object.fromEntries(
  INSTRUCTION_NAMES.map((n) => [n, instructionDiscriminator(n)]),
) as Readonly<Record<InstructionName, Uint8Array>>;

export const ACCOUNT_DISCRIMINATORS = Object.fromEntries(
  ACCOUNT_NAMES.map((n) => [n, accountDiscriminator(n)]),
) as Readonly<Record<AccountName, Uint8Array>>;

export const EVENT_DISCRIMINATORS = Object.fromEntries(
  EVENT_NAMES.map((n) => [n, eventDiscriminator(n)]),
) as Readonly<Record<EventName, Uint8Array>>;

export function startsWith(data: ReadonlyUint8Array, prefix: Uint8Array): boolean {
  if (data.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (data[i] !== prefix[i]) return false;
  return true;
}

/** Which Chalk Chain instruction some instruction data is for (by its 8-byte discriminator), or null. */
export function identifyInstruction(data: ReadonlyUint8Array): InstructionName | null {
  return INSTRUCTION_NAMES.find((n) => startsWith(data, INSTRUCTION_DISCRIMINATORS[n])) ?? null;
}

export function identifyAccount(data: ReadonlyUint8Array): AccountName | null {
  return ACCOUNT_NAMES.find((n) => startsWith(data, ACCOUNT_DISCRIMINATORS[n])) ?? null;
}
