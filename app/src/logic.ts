import {
  addressBytes,
  challenge,
  flagsToChecks,
  fromHex,
  prevFor,
  USDC_DECIMALS,
  wordsFor,
  type DayAccount,
  type Lang,
} from '@chalk/shared';
import type { Address } from '@solana/kit';
import type { VerifyResult } from './api.ts';

// Pure helpers (no DOM, no network) so they can be unit tested.

export const DEFAULT_SLOT_MS = 400;

export type LinkKind = 'check_in' | 'recheck_in';

export interface NextLink {
  idx: number;
  kind: LinkKind;
}

/** Which link the teacher can add now, or null when there is nothing to answer. */
export function nextLink(day: DayAccount | null, maxLinks = 6): NextLink | null {
  if (!day || day.nLinks === 0) return { idx: 0, kind: 'check_in' };
  if (day.settled || !day.recheckPending || day.nLinks >= maxLinks) return null;
  return { idx: day.nLinks, kind: 'recheck_in' };
}

export interface WordsForLink extends NextLink {
  words: string[];
  /** Words already on the board (earlier links), oldest first. */
  prior: string[][];
}

/**
 * The 3 words for the next link: link 0 chains from prev_0, link k from links[k-1].commit.
 * `slotHashHex` is the `hash` from GET /slot.
 */
export function wordsForNext(
  wallet: Address,
  dayNum: number,
  day: DayAccount | null,
  slotHashHex: string,
  lang: Lang,
  maxLinks = 6,
): WordsForLink | null {
  const next = nextLink(day, maxLinks);
  if (!next) return null;
  const teacher = addressBytes(wallet);
  const links = day?.links ?? [];
  const last = next.idx > 0 ? links[next.idx - 1]?.commit : null;
  if (next.idx > 0 && !last) throw new Error('missing previous link');
  const { words } = challenge(fromHex(slotHashHex), teacher, prevFor(teacher, dayNum, last), lang);
  return { ...next, words, prior: links.slice(0, next.idx).map((l) => wordsFor(l.words, lang)) };
}

/** Time left to send the photo: the program accepts it while now - slot <= window_slots. */
export function windowMsLeft(
  p: { windowSlots: number; slot: number; currentSlot: number; slotMs: number },
  elapsedMs = 0,
): number {
  const age = Math.max(0, p.currentSlot - p.slot);
  return Math.max(0, (p.windowSlots - age) * p.slotMs - elapsedMs);
}

/** Time left before a re-check deadline slot passes. */
export function slotsMsLeft(deadlineSlot: number, currentSlot: number, slotMs: number, elapsedMs = 0): number {
  return Math.max(0, (deadlineSlot - currentSlot) * slotMs - elapsedMs);
}

/** Seconds between the words appearing (challenge slot) and the photo landing on-chain. */
export function sealedSeconds(slotAge: number, slotMs: number): number {
  return Math.max(0, Math.round((slotAge * slotMs) / 1000));
}

export function formatCountdown(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** USDC base units (6 decimals) as "1.25". */
export function formatUsdc(amount: bigint | string | number): string {
  const v = BigInt(amount);
  const unit = 10n ** BigInt(USDC_DECIMALS);
  const frac = (v % unit).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  return `${v / unit}${frac ? '.' + frac.padEnd(2, '0') : ''}`;
}

export interface CheckRow {
  key: string;
  label: string;
  ok: boolean;
  detail?: string;
}

/** Rows for the Checking screen. `ok` comes from the attested flags, so it matches what is on-chain. */
export function checkRows(r: VerifyResult, idx: number): CheckRow[] {
  const f = flagsToChecks(r.flags);
  const found = r.words_found?.filter(Boolean).length ?? 0;
  const rows: CheckRow[] = [
    { key: 'words', label: 'Words', ok: f.wordsOk, detail: `${found} of 3 found` },
  ];
  if (idx >= 1) rows.push({ key: 'chain', label: 'Earlier words', ok: f.chainOk, detail: f.chainOk ? 'Still on the board' : 'Not all found' });
  rows.push(
    { key: 'people', label: `People (${r.headcount ?? 0})`, ok: f.peopleOk },
    { key: 'real', label: 'Real photo', ok: f.notRecapture, detail: 'Not a photo of a screen' },
    { key: 'new', label: 'New photo', ok: f.notReused, detail: 'Not used before' },
  );
  return rows;
}

/** Overall pass for the checks the vision service reports (ATTESTED is added on-chain). */
export function checksPass(flags: number): boolean {
  return (flags & 0x1f) === 0x1f;
}

/** Big slot values come as strings; slots fit easily in a JS number. */
export const num = (x: number | string | bigint | undefined | null, fallback = 0): number =>
  x === undefined || x === null || x === '' ? fallback : Number(x);
