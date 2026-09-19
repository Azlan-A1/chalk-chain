import en from '../../wordlists/en.json' with { type: 'json' };
import sw from '../../wordlists/sw.json' with { type: 'json' };

export type Lang = 'en' | 'sw';
export const LANGS: readonly Lang[] = ['en', 'sw'];

function check(lang: Lang, words: string[]): readonly string[] {
  if (words.length !== 256) throw new Error(`wordlist ${lang} has ${words.length} words, expected 256`);
  return Object.freeze([...words]);
}

export const WORDLISTS: Readonly<Record<Lang, readonly string[]>> = {
  en: check('en', en),
  sw: check('sw', sw),
};

export function wordlist(lang: Lang): readonly string[] {
  const list = WORDLISTS[lang];
  if (!list) throw new Error(`unknown language: ${lang}`);
  return list;
}

export function isLang(x: unknown): x is Lang {
  return x === 'en' || x === 'sw';
}
