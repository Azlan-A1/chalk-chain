import { address, type Address } from '@solana/kit';

// SPEC §2.1 / §2.2. Program ID is not fixed here: read it from shared/deploy.json.

export const SYSVAR_SLOT_HASHES_ADDRESS: Address = address('SysvarS1otHashes111111111111111111111111111');
export const SYSTEM_PROGRAM_ADDRESS: Address = address('11111111111111111111111111111111');
export const TOKEN_PROGRAM_ADDRESS: Address = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOCIATED_TOKEN_PROGRAM_ADDRESS: Address = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const COMPUTE_BUDGET_PROGRAM_ADDRESS: Address = address('ComputeBudget111111111111111111111111111111');

export const CONFIG_SEED = 'config';
export const VAULT_SEED = 'vault';
export const TEACHER_SEED = 'teacher';
export const DAY_SEED = 'day';

export const MAX_LINKS = 6;
export const USDC_DECIMALS = 6;

// Link flag bits (set by attest).
export const WORDS_OK = 1;
export const CHAIN_OK = 2;
export const NOT_RECAPTURE = 4;
export const NOT_REUSED = 8;
export const PEOPLE_OK = 16;
export const ATTESTED = 128;
export const PASS_MASK = 0b1001_1111;

export const FLAGS = { WORDS_OK, CHAIN_OK, NOT_RECAPTURE, NOT_REUSED, PEOPLE_OK, ATTESTED } as const;

/** A link passes when all five checks and ATTESTED are set. */
export function linkPasses(flags: number): boolean {
  return (flags & PASS_MASK) === PASS_MASK;
}

/** Builds the flags byte the oracle sends to attest (ATTESTED is added on-chain, but setting it here is harmless). */
export function flagsFrom(checks: {
  wordsOk: boolean;
  chainOk: boolean;
  notRecapture: boolean;
  notReused: boolean;
  peopleOk: boolean;
}): number {
  return (
    (checks.wordsOk ? WORDS_OK : 0) |
    (checks.chainOk ? CHAIN_OK : 0) |
    (checks.notRecapture ? NOT_RECAPTURE : 0) |
    (checks.notReused ? NOT_REUSED : 0) |
    (checks.peopleOk ? PEOPLE_OK : 0)
  );
}

export function flagsToChecks(flags: number) {
  return {
    wordsOk: (flags & WORDS_OK) !== 0,
    chainOk: (flags & CHAIN_OK) !== 0,
    notRecapture: (flags & NOT_RECAPTURE) !== 0,
    notReused: (flags & NOT_REUSED) !== 0,
    peopleOk: (flags & PEOPLE_OK) !== 0,
    attested: (flags & ATTESTED) !== 0,
  };
}
