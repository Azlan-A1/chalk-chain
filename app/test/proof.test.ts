import { ATTESTED, PASS_MASK, type DayAccount, type Link } from '@chalk/shared';
import { address } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import {
  explorerAddressUrl,
  formatUsdc2,
  isPhotoStale,
  linkChips,
  parseRoute,
  photoActions,
  PHOTO_MAX_AGE_MS,
  proofHash,
} from '../src/logic.ts';

const WALLET = '3kRyrq1T5AXEyPVbBWNLCE9Uj2AzwZ51MkqsUvD3CT4Q';

describe('hash routes', () => {
  it('anything that is not #/t/... is the teacher app', () => {
    expect(parseRoute('')).toEqual({ t: 'app' });
    expect(parseRoute('#')).toEqual({ t: 'app' });
    expect(parseRoute('#/')).toEqual({ t: 'app' });
    expect(parseRoute('#/settings')).toEqual({ t: 'app' });
  });

  it('#/t/<wallet> is today, #/t/<wallet>/<day> a given day, ?lang= optional', () => {
    expect(parseRoute(`#/t/${WALLET}`)).toEqual({ t: 'proof', wallet: WALLET, day: null, lang: null });
    expect(parseRoute(`#/t/${WALLET}/`)).toEqual({ t: 'proof', wallet: WALLET, day: null, lang: null });
    expect(parseRoute(`#/t/${WALLET}/20715`)).toEqual({ t: 'proof', wallet: WALLET, day: 20715, lang: null });
    expect(parseRoute(`#/t/${WALLET}/20715?lang=sw`)).toEqual({ t: 'proof', wallet: WALLET, day: 20715, lang: 'sw' });
    expect(parseRoute(`#/t/${WALLET}?lang=fr`)).toEqual({ t: 'proof', wallet: WALLET, day: null, lang: null });
    expect(parseRoute(`/t/${WALLET}/0`)).toMatchObject({ t: 'proof', day: 0 });
  });

  it('rejects bad wallets and days', () => {
    expect(parseRoute('#/t/')).toEqual({ t: 'bad-proof' });
    expect(parseRoute('#/t/not-a-wallet')).toEqual({ t: 'bad-proof' });
    expect(parseRoute(`#/t/${WALLET}x`)).toEqual({ t: 'bad-proof' });
    expect(parseRoute(`#/t/${WALLET}/-1`)).toEqual({ t: 'bad-proof' });
    expect(parseRoute(`#/t/${WALLET}/1.5`)).toEqual({ t: 'bad-proof' });
    expect(parseRoute(`#/t/${WALLET}/4294967296`)).toEqual({ t: 'bad-proof' });
    expect(parseRoute(`#/t/${WALLET}/1/extra`)).toEqual({ t: 'bad-proof' });
  });

  it('proofHash round-trips through parseRoute', () => {
    expect(proofHash(WALLET)).toBe(`#/t/${WALLET}`);
    expect(proofHash(WALLET, 20715, 'sw')).toBe(`#/t/${WALLET}/20715?lang=sw`);
    expect(parseRoute(proofHash(WALLET, 20715, 'en'))).toEqual({ t: 'proof', wallet: WALLET, day: 20715, lang: 'en' });
    expect(parseRoute(proofHash(WALLET, null, 'sw'))).toEqual({ t: 'proof', wallet: WALLET, day: null, lang: 'sw' });
  });
});

describe('explorer links', () => {
  const pda = 'Day1111111111111111111111111111111111111111';
  it('localnet points Explorer at the custom RPC URL', () => {
    expect(explorerAddressUrl(pda, { cluster: 'localnet', rpcUrl: 'http://127.0.0.1:8899' })).toBe(
      `https://explorer.solana.com/address/${pda}?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899`,
    );
  });
  it('devnet uses the named cluster, mainnet none', () => {
    expect(explorerAddressUrl(pda, { cluster: 'devnet', rpcUrl: 'https://api.devnet.solana.com' })).toBe(
      `https://explorer.solana.com/address/${pda}?cluster=devnet`,
    );
    expect(explorerAddressUrl(pda, { cluster: 'mainnet-beta', rpcUrl: 'x' })).toBe(`https://explorer.solana.com/address/${pda}`);
  });
});

describe('stored photo rules', () => {
  const now = Date.UTC(2026, 8, 19, 18);

  it('purges photos older than 2 days', () => {
    expect(isPhotoStale(now, now)).toBe(false);
    expect(isPhotoStale(now - PHOTO_MAX_AGE_MS, now)).toBe(false);
    expect(isPhotoStale(now - PHOTO_MAX_AGE_MS - 1, now)).toBe(true);
    expect(isPhotoStale(now - 3 * 86_400_000, now)).toBe(true);
    expect(isPhotoStale(Number.NaN, now)).toBe(true);
    expect(isPhotoStale(undefined as unknown as number, now)).toBe(true);
  });

  const link = (flags: number): Link => ({
    slot: 1n,
    photoHash: new Uint8Array(32),
    seed: new Uint8Array(32),
    commit: new Uint8Array(32),
    words: [0, 1, 2],
    flags,
    headcount: 7,
    passes: (flags & PASS_MASK) === PASS_MASK,
  });
  const day = (links: Link[], settled = false): DayAccount => ({
    teacher: address(WALLET),
    day: 20715,
    nLinks: links.length,
    recheckPending: false,
    rechecksMet: 0,
    missedRecheck: false,
    settled,
    bump: 255,
    recheckFromSlot: 0n,
    recheckDeadlineSlot: 0n,
    lastRolledBoundary: 0n,
    paid: 0n,
    links,
  });

  it('retries recorded-but-unattested links and drops attested ones', () => {
    const d = day([link(PASS_MASK), link(0), link(ATTESTED)]);
    expect(photoActions(d, [0, 1, 2])).toEqual({ retry: [1], drop: [0, 2] });
  });

  it('drops everything once the day is settled, and leaves links the chain does not show yet', () => {
    expect(photoActions(day([link(0)], true), [0, 3])).toEqual({ retry: [], drop: [0, 3] });
    expect(photoActions(day([link(0)]), [0, 1])).toEqual({ retry: [0], drop: [] });
    expect(photoActions(null, [0])).toEqual({ retry: [], drop: [] });
  });
});

describe('proof formatting', () => {
  it('USDC with exactly 2 decimals', () => {
    expect(formatUsdc2(0n)).toBe('0.00');
    expect(formatUsdc2(250_000n)).toBe('0.25');
    expect(formatUsdc2('1500000')).toBe('1.50');
    expect(formatUsdc2(2_000_000)).toBe('2.00');
    expect(formatUsdc2(1_234_567n)).toBe('1.23');
    expect(formatUsdc2(1_235_000n)).toBe('1.24');
    expect(formatUsdc2(123_456_789_000n)).toBe('123456.79');
  });

  it('link chips show head count and hide "Earlier words" on link 0', () => {
    expect(linkChips(PASS_MASK, 7, 0).map(([l]) => l)).toEqual(['Words', 'People (7)', 'Real photo', 'New photo']);
    const chips = linkChips(ATTESTED | (0x1f & ~2), 3, 1);
    expect(chips.find(([l]) => l === 'Earlier words')?.[1]).toBe(false);
    expect(chips.find(([l]) => l === 'People (3)')?.[1]).toBe(true);
  });
});
