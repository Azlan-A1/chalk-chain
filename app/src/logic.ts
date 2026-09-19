import {
  addressBytes,
  ATTESTED,
  challenge,
  flagsToChecks,
  fromHex,
  isLang,
  prevFor,
  USDC_DECIMALS,
  wordsFor,
  type DayAccount,
  type Lang,
} from '@chalk/shared';
import { isAddress, type Address } from '@solana/kit';
import type { VerifyResult } from './api.ts';

// Pure helpers (no DOM, no network) so they can be unit tested.

export const DEFAULT_SLOT_MS = 400;

export type LinkKind = 'check_in' | 'recheck_in';

export interface NextLink {
  idx: number;
  kind: LinkKind;
}

/** Which link the teacher can add now, or null when there is nothing to answer.
 *  `currentSlot`, when known, drops a re-check whose deadline has already passed: the program
 *  would reject the photo with RecheckExpired, so offering it is a loop the teacher cannot win. */
export function nextLink(day: DayAccount | null, maxLinks = 6, currentSlot?: number): NextLink | null {
  if (!day || day.nLinks === 0) return { idx: 0, kind: 'check_in' };
  if (day.settled || !day.recheckPending || day.nLinks >= maxLinks) return null;
  if (currentSlot !== undefined && currentSlot > Number(day.recheckDeadlineSlot)) return null;
  return { idx: day.nLinks, kind: 'recheck_in' };
}

/** True when a re-check was opened and its deadline passed unanswered. */
export function recheckMissed(day: DayAccount | null, currentSlot?: number): boolean {
  if (!day || !day.recheckPending || day.settled || currentSlot === undefined) return false;
  return currentSlot > Number(day.recheckDeadlineSlot);
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

/** USDC base units as a fixed 2-decimal amount, rounded half up: "0.50". */
export function formatUsdc2(amount: bigint | string | number): string {
  const cents = (BigInt(amount) * 100n + 10n ** BigInt(USDC_DECIMALS) / 2n) / 10n ** BigInt(USDC_DECIMALS);
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
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

/** Chips for one link as stored on-chain; "Earlier words" only applies from link 1. */
export function linkChips(flags: number, headcount: number, idx: number): [string, boolean][] {
  const c = flagsToChecks(flags);
  return [
    ['Words', c.wordsOk],
    ...(idx > 0 ? ([['Earlier words', c.chainOk]] as [string, boolean][]) : []),
    [`People (${headcount})`, c.peopleOk],
    ['Real photo', c.notRecapture],
    ['New photo', c.notReused],
  ];
}

// Unverified photos kept on the phone (IndexedDB) until /verify succeeds.

export const PHOTO_MAX_AGE_MS = 2 * 86_400_000;

export function isPhotoStale(savedAt: number, now: number, maxAgeMs = PHOTO_MAX_AGE_MS): boolean {
  return !(now - savedAt <= maxAgeMs); // a missing or bad timestamp counts as stale
}

/**
 * For the link indices with a stored photo: which still need a check (recorded, not attested)
 * and which can be dropped (attested, or the day is settled so /verify would be refused).
 * Indices the chain doesn't show yet are left alone; the age purge handles them.
 */
export function photoActions(day: DayAccount | null, stored: readonly number[]): { retry: number[]; drop: number[] } {
  const retry: number[] = [];
  const drop: number[] = [];
  if (!day) return { retry, drop };
  for (const i of stored) {
    const link = day.links[i];
    if (day.settled) drop.push(i);
    else if (!link) continue;
    else if (link.flags & ATTESTED) drop.push(i);
    else retry.push(i);
  }
  return { retry, drop };
}

// Hash routes: #/t/<wallet> (today) and #/t/<wallet>/<day>, optional ?lang=en|sw.

export type Route =
  | { t: 'app' }
  | { t: 'proof'; wallet: Address; day: number | null; lang: Lang | null }
  | { t: 'bad-proof' };

export function parseRoute(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#/, '').split('?', 2);
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 't') return { t: 'app' };
  const [, wallet, dayPart, ...rest] = parts;
  if (!wallet || rest.length > 0 || !isAddress(wallet)) return { t: 'bad-proof' };
  let day: number | null = null;
  if (dayPart !== undefined) {
    if (!/^\d{1,10}$/.test(dayPart) || Number(dayPart) > 0xffff_ffff) return { t: 'bad-proof' };
    day = Number(dayPart);
  }
  const lang = new URLSearchParams(query).get('lang');
  return { t: 'proof', wallet, day, lang: isLang(lang) ? lang : null };
}

export function proofHash(wallet: string, day?: number | null, lang?: Lang | null): string {
  return `#/t/${wallet}${day !== undefined && day !== null ? `/${day}` : ''}${lang ? `?lang=${lang}` : ''}`;
}

/** Solana Explorer page for an account on the backend's cluster (localnet → custom RPC URL). */
export function explorerAddressUrl(addr: string, h: { cluster: string; rpcUrl: string; publicRpcUrl?: string }): string {
  const base = `https://explorer.solana.com/address/${addr}`;
  if (h.cluster === 'mainnet' || h.cluster === 'mainnet-beta') return base;
  if (h.cluster === 'devnet' || h.cluster === 'testnet') return `${base}?cluster=${h.cluster}`;
  // A localnet URL only resolves on the machine running the validator; the demo tunnel publishes
  // one that anybody's phone can reach, so prefer it when there is one.
  return `${base}?cluster=custom&customUrl=${encodeURIComponent(h.publicRpcUrl || h.rpcUrl)}`;
}

/** A UTC day number (what the program uses) as a calendar date. */
export function dayDate(day: number, opts: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }): string {
  return new Date(day * 86_400_000).toLocaleDateString([], { ...opts, timeZone: 'UTC' });
}
