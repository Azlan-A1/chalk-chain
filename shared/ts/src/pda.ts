import { getAddressEncoder, getProgramDerivedAddress, type Address, type ProgramDerivedAddress } from '@solana/kit';
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  CONFIG_SEED,
  DAY_SEED,
  TEACHER_SEED,
  TOKEN_PROGRAM_ADDRESS,
  VAULT_SEED,
} from './constants.ts';
import { u32le } from './derive.ts';

// SPEC §2.1. Each returns [address, bump].

const addr = (a: Address) => getAddressEncoder().encode(a);

export function findConfigPda(programAddress: Address): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({ programAddress, seeds: [CONFIG_SEED] });
}

export function findVaultAuthorityPda(programAddress: Address): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({ programAddress, seeds: [VAULT_SEED] });
}

export function findTeacherPda(programAddress: Address, teacher: Address): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({ programAddress, seeds: [TEACHER_SEED, addr(teacher)] });
}

export function findDayPda(programAddress: Address, teacher: Address, day: number): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({ programAddress, seeds: [DAY_SEED, addr(teacher), u32le(day)] });
}

/** Associated token account of (owner, mint) under the classic SPL Token program. */
export function findAssociatedTokenAddress(
  owner: Address,
  mint: Address,
  tokenProgram: Address = TOKEN_PROGRAM_ADDRESS,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    seeds: [addr(owner), addr(tokenProgram), addr(mint)],
  });
}

/** The vault token account: ATA of (vault authority PDA, usdc mint). */
export async function findVaultAta(programAddress: Address, usdcMint: Address): Promise<ProgramDerivedAddress> {
  const [vaultAuthority] = await findVaultAuthorityPda(programAddress);
  return findAssociatedTokenAddress(vaultAuthority, usdcMint);
}
