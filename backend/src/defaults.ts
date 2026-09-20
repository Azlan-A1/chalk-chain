import type { Address } from '@solana/kit';
import { USDC_DECIMALS, type ConfigArgs } from '@chalk/shared';

/** "12.5" → 12_500_000n base units. */
export function parseUsdc(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{0,6}))?$/.exec(s.trim());
  if (!m) throw new Error(`bad USDC amount: ${s} (max ${USDC_DECIMALS} decimals)`);
  return BigInt(m[1]!) * 10n ** BigInt(USDC_DECIMALS) + BigInt((m[2] ?? '').padEnd(USDC_DECIMALS, '0'));
}

/** Default ConfigArgs: 90 s check-in window, 180 s re-check window, 120 s boundary spacing. */
export function defaultConfigArgs(oracle: Address, slotMs: number): ConfigArgs {
  const slots = (ms: number) => BigInt(Math.ceil(ms / slotMs));
  return {
    oracle,
    // 150 s: a real run on a phone sealed in 70 s, and a judge picking the moment plus writing
    // three words on a whiteboard needs the headroom.
    windowSlots: slots(150_000),
    recheckWindowSlots: slots(180_000),
    recheckIntervalSlots: slots(120_000),
    bonusPerLink: 600_000n,
    recheckThreshold: 64,
    maxLinks: 6,
    minHeadcount: 1, // the photo must show someone; 3 failed empty-room rehearsals
  };
}
