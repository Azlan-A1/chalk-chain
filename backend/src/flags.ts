import { flagsFrom } from '@chalk/shared';

// Vision response, SPEC §3. Only the fields the flags depend on are typed strictly.
export interface VisionResult {
  words_ok: boolean;
  chain_ok: boolean;
  headcount: number;
  is_recapture: boolean;
  reuse?: { is_reuse: boolean; [k: string]: unknown } | null;
  [k: string]: unknown;
}

/**
 * attest flags from a vision result. Fails closed: a missing field clears its bit.
 * CHAIN_OK is vacuously true for link 0 (no prior words to find).
 */
export function flagsFromVision(v: VisionResult, minHeadcount: number, priorLinks: number): number {
  return flagsFrom({
    wordsOk: v.words_ok === true,
    chainOk: v.chain_ok === true || priorLinks === 0,
    notRecapture: v.is_recapture === false,
    notReused: v.reuse?.is_reuse === false,
    peopleOk: typeof v.headcount === 'number' && v.headcount >= minHeadcount,
  });
}
