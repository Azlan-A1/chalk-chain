import { address } from '@solana/kit';
import type { ConfigAccount, DayAccount, Link, TeacherAccount, WordTriple } from './accounts.ts';
import { linkPasses } from './constants.ts';
import { wordsFor } from './derive.ts';
import type { Lang } from './wordlists.ts';
import { fromHex, toHex } from './util.ts';

// Wire shapes for the backend's GET /config, /teacher, /day: u64 → decimal string, bytes → lowercase hex.

export interface ConfigJson {
  admin: string;
  oracle: string;
  usdcMint: string;
  windowSlots: string;
  recheckWindowSlots: string;
  recheckIntervalSlots: string;
  bonusPerLink: string;
  recheckThreshold: number;
  maxLinks: number;
  minHeadcount: number;
  bump: number;
  vaultBump: number;
}

export interface TeacherJson {
  wallet: string;
  schoolId: number;
  daysSettled: number;
  totalPaid: string;
  bump: number;
}

export interface LinkJson {
  slot: string;
  photoHash: string;
  seed: string;
  commit: string;
  words: WordTriple;
  /** words resolved in DayJson.lang */
  wordsText: string[];
  flags: number;
  headcount: number;
  passes: boolean;
}

export interface DayJson {
  teacher: string;
  day: number;
  nLinks: number;
  recheckPending: boolean;
  rechecksMet: number;
  missedRecheck: boolean;
  settled: boolean;
  bump: number;
  recheckFromSlot: string;
  recheckDeadlineSlot: string;
  lastRolledBoundary: string;
  paid: string;
  lang: Lang;
  links: LinkJson[];
}

export function configToJson(c: ConfigAccount): ConfigJson {
  return {
    ...c,
    windowSlots: c.windowSlots.toString(),
    recheckWindowSlots: c.recheckWindowSlots.toString(),
    recheckIntervalSlots: c.recheckIntervalSlots.toString(),
    bonusPerLink: c.bonusPerLink.toString(),
  };
}

export function configFromJson(j: ConfigJson): ConfigAccount {
  return {
    ...j,
    admin: address(j.admin),
    oracle: address(j.oracle),
    usdcMint: address(j.usdcMint),
    windowSlots: BigInt(j.windowSlots),
    recheckWindowSlots: BigInt(j.recheckWindowSlots),
    recheckIntervalSlots: BigInt(j.recheckIntervalSlots),
    bonusPerLink: BigInt(j.bonusPerLink),
  };
}

export function teacherToJson(t: TeacherAccount): TeacherJson {
  return { ...t, totalPaid: t.totalPaid.toString() };
}

export function teacherFromJson(j: TeacherJson): TeacherAccount {
  return { ...j, wallet: address(j.wallet), totalPaid: BigInt(j.totalPaid) };
}

export function dayToJson(d: DayAccount, lang: Lang = 'en'): DayJson {
  return {
    ...d,
    recheckFromSlot: d.recheckFromSlot.toString(),
    recheckDeadlineSlot: d.recheckDeadlineSlot.toString(),
    lastRolledBoundary: d.lastRolledBoundary.toString(),
    paid: d.paid.toString(),
    lang,
    links: d.links.map((l) => ({
      ...l,
      slot: l.slot.toString(),
      photoHash: toHex(l.photoHash),
      seed: toHex(l.seed),
      commit: toHex(l.commit),
      words: [...l.words] as WordTriple,
      wordsText: wordsFor(l.words, lang),
    })),
  };
}

export function dayFromJson(j: DayJson): DayAccount {
  const { lang: _lang, ...rest } = j;
  return {
    ...rest,
    teacher: address(j.teacher),
    recheckFromSlot: BigInt(j.recheckFromSlot),
    recheckDeadlineSlot: BigInt(j.recheckDeadlineSlot),
    lastRolledBoundary: BigInt(j.lastRolledBoundary),
    paid: BigInt(j.paid),
    links: j.links.map(
      (l): Link => ({
        slot: BigInt(l.slot),
        photoHash: fromHex(l.photoHash),
        seed: fromHex(l.seed),
        commit: fromHex(l.commit),
        words: [...l.words] as WordTriple,
        flags: l.flags,
        headcount: l.headcount,
        passes: linkPasses(l.flags),
      }),
    ),
  };
}
