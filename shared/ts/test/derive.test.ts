import { describe, expect, it } from 'vitest';
import vectors from '../../vectors/derivation.json' with { type: 'json' };
import {
  commit,
  deriveChain,
  fromHex,
  prev0,
  seed,
  toHex,
  u32le,
  wordIndices,
  wordlist,
  wordsFor,
} from '../src/index.ts';

describe('derivation vectors (shared/vectors/derivation.json)', () => {
  it('has cases', () => {
    expect(vectors.domain).toBe('chalk-chain');
    expect(vectors.cases.length).toBeGreaterThan(0);
  });

  for (const [ci, c] of vectors.cases.entries()) {
    describe(`case ${ci}`, () => {
      const teacher = fromHex(c.teacher);

      it('day_le and prev0', () => {
        expect(toHex(u32le(c.day))).toBe(c.day_le);
        expect(toHex(prev0(teacher, c.day))).toBe(c.prev0);
      });

      it('each link: seed, words, words_en, words_sw, commit', () => {
        let prev = prev0(teacher, c.day);
        for (const l of c.links) {
          expect(toHex(prev)).toBe(l.prev);
          const s = seed(fromHex(l.slot_hash), teacher, prev);
          expect(toHex(s)).toBe(l.seed);
          const idx = wordIndices(s);
          expect(idx).toEqual(l.words);
          expect(wordsFor(idx, 'en')).toEqual(l.words_en);
          expect(wordsFor(idx, 'sw')).toEqual(l.words_sw);
          const cm = commit(fromHex(l.photo_hash), s);
          expect(toHex(cm)).toBe(l.commit);
          prev = cm;
        }
      });

      it('deriveChain matches', () => {
        const chain = deriveChain(
          teacher,
          c.day,
          c.links.map((l) => fromHex(l.slot_hash)),
          c.links.map((l) => fromHex(l.photo_hash)),
        );
        expect(chain.map((l) => toHex(l.commit))).toEqual(c.links.map((l) => l.commit));
        expect(chain.map((l) => l.words)).toEqual(c.links.map((l) => l.words));
      });
    });
  }

  it('word lists have 256 lowercase words', () => {
    for (const lang of ['en', 'sw'] as const) {
      const list = wordlist(lang);
      expect(list).toHaveLength(256);
      for (const w of list) expect(w).toBe(w.toLowerCase());
    }
  });

  it('rejects bad lengths', () => {
    expect(() => prev0(new Uint8Array(31), 1)).toThrow();
    expect(() => seed(new Uint8Array(32), new Uint8Array(32), new Uint8Array(3))).toThrow();
  });
});
