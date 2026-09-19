import { address } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import {
  configFromJson,
  configToJson,
  dayFromJson,
  dayToJson,
  decodeDay,
  encodeDay,
  PASS_MASK,
  teacherFromJson,
  teacherToJson,
  type ConfigAccount,
  type DayJson,
  type TeacherAccount,
} from '../src/index.ts';

const T = address('So11111111111111111111111111111111111111112');

describe('JSON wire shapes', () => {
  it('Day survives JSON.stringify/parse with words resolved', () => {
    const day = decodeDay(
      encodeDay({
        teacher: T,
        day: 20715,
        nLinks: 1,
        recheckPending: false,
        rechecksMet: 0,
        missedRecheck: false,
        settled: true,
        bump: 255,
        recheckFromSlot: 0n,
        recheckDeadlineSlot: 0n,
        lastRolledBoundary: 0n,
        paid: 250_000n,
        links: [
          {
            slot: 99n,
            photoHash: new Uint8Array(32).fill(0xab),
            seed: new Uint8Array(32).fill(1),
            commit: new Uint8Array(32).fill(0xcd),
            words: [82, 43, 28],
            flags: PASS_MASK,
            headcount: 12,
          },
        ],
      }),
    );
    const wire = JSON.parse(JSON.stringify(dayToJson(day, 'sw'))) as DayJson;
    expect(wire.links[0]!.wordsText).toEqual(['kichwa', 'filimbi', 'daftari']);
    expect(wire.links[0]!.commit).toBe('cd'.repeat(32));
    expect(wire.paid).toBe('250000');
    expect(dayFromJson(wire)).toEqual(day);
  });

  it('Config and Teacher round-trip', () => {
    const c: ConfigAccount = {
      admin: T,
      oracle: T,
      usdcMint: T,
      windowSlots: 225n,
      recheckWindowSlots: 1n,
      recheckIntervalSlots: 2n,
      bonusPerLink: 3n,
      recheckThreshold: 4,
      maxLinks: 6,
      minHeadcount: 1,
      bump: 1,
      vaultBump: 2,
    };
    expect(configFromJson(JSON.parse(JSON.stringify(configToJson(c))))).toEqual(c);
    const t: TeacherAccount = { wallet: T, schoolId: 1, daysSettled: 2, totalPaid: 18446744073709551615n, bump: 3 };
    expect(teacherFromJson(JSON.parse(JSON.stringify(teacherToJson(t))))).toEqual(t);
  });
});
