import {
  AccountRole,
  appendTransactionMessageInstructions,
  blockhash,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  isFullySignedTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type TransactionSigner,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  getAttestInstruction,
  getCheckInInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getRecheckInInstruction,
  getRegisterTeacherInstruction,
  getRollRecheckInstruction,
} from '@chalk/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkRelayTransaction, cosign, type RelayPolicy } from '../src/relay.ts';

let relayer: KeyPairSigner;
let relayerNoop: TransactionSigner;
let teacher: KeyPairSigner;
let PROGRAM: Address;
let USDC: Address;
let policy: RelayPolicy;
const DAY = 20715;
const PH = new Uint8Array(32).fill(7);

beforeAll(async () => {
  relayer = await generateKeyPairSigner();
  relayerNoop = createNoopSigner(relayer.address);
  teacher = await generateKeyPairSigner();
  PROGRAM = (await generateKeyPairSigner()).address;
  USDC = (await generateKeyPairSigner()).address;
  policy = { relayer: relayer.address, programId: PROGRAM, usdcMint: USDC };
});

/** Builds the base64 wire tx the way the app does: fee payer = relayer (noop), teacher signs. */
async function wire(ixs: Instruction[], feePayer: TransactionSigner = relayerNoop): Promise<string> {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash('11111111111111111111111111111111'), lastValidBlockHeight: 1000n },
        m,
      ),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  return getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(msg));
}

const checkIn = (t: TransactionSigner = teacher, payer: TransactionSigner | Address = relayer.address) =>
  getCheckInInstruction({ programAddress: PROGRAM, payer, teacher: t, day: DAY, slot: 100n, photoHash: PH });

const cuLimit = (units: number): Instruction => {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS, data };
};
const cuPrice = (micro: bigint): Instruction => {
  const data = new Uint8Array(9);
  data[0] = 3;
  new DataView(data.buffer).setBigUint64(1, micro, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS, data };
};

async function expectReject(ixs: Instruction[], pattern: RegExp, feePayer?: TransactionSigner) {
  const r = checkRelayTransaction(await wire(ixs, feePayer), policy);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toMatch(pattern);
}

describe('relay: accepted transactions', () => {
  it('check_in with the relayer as fee payer and rent payer; cosign completes it', async () => {
    const r = checkRelayTransaction(await wire([await checkIn()]), policy);
    expect(r).toMatchObject({ ok: true, instructions: ['check_in'] });
    if (!r.ok) return;
    expect(isFullySignedTransaction(r.tx)).toBe(false);
    const signed = await cosign(r.tx, relayer);
    expect(isFullySignedTransaction(signed.tx)).toBe(true);
    expect(signed.signature).toBe(getSignatureFromTransaction(signed.tx));
    expect(Object.keys(signed.tx.signatures)[0]).toBe(relayer.address);
  });

  it('compute budget + register_teacher + check_in', async () => {
    const ixs = [
      cuLimit(300_000),
      cuPrice(1_000n),
      await getRegisterTeacherInstruction({ programAddress: PROGRAM, payer: relayer.address, teacher, schoolId: 42 }),
      await checkIn(),
    ];
    expect(checkRelayTransaction(await wire(ixs), policy)).toMatchObject({
      ok: true,
      instructions: ['register_teacher', 'check_in'],
    });
  });

  it('recheck_in (relayer only pays the fee)', async () => {
    const ix = await getRecheckInInstruction({ programAddress: PROGRAM, teacher, day: DAY, slot: 200n, photoHash: PH });
    expect(checkRelayTransaction(await wire([ix]), policy)).toMatchObject({ ok: true, instructions: ['recheck_in'] });
  });

  it.skip('ATA CreateIdempotent for the USDC mint paid by the relayer', async () => {
    const ata = await getCreateAssociatedTokenIdempotentInstruction({ payer: relayer.address, owner: teacher.address, mint: USDC });
    expect(checkRelayTransaction(await wire([ata, await checkIn()]), policy).ok).toBe(true);
  });
});

describe('relay: rejected transactions', () => {
  it('fee payer is not the relayer', async () => {
    await expectReject([await checkIn(teacher, teacher)], /Fee payer must be the relayer/, teacher);
  });

  it('foreign program: system transfer draining the relayer', async () => {
    const drain = getTransferSolInstruction({ source: relayerNoop, destination: teacher.address, amount: 1_000_000_000n });
    await expectReject([await checkIn(), drain], /program 1{32} is not allowed/);
  });

  it('foreign program with no accounts', async () => {
    const memo: Instruction = { programAddress: USDC, data: new Uint8Array([1, 2, 3]) };
    await expectReject([await checkIn(), memo], /is not allowed/);
  });

  it('relayer used as the teacher signer', async () => {
    await expectReject([await checkIn(relayerNoop)], /relayer may only be used as fee payer/);
  });

  it('relayer used as a writable account in recheck_in', async () => {
    const ix = await getRecheckInInstruction({ programAddress: PROGRAM, teacher, day: DAY, slot: 200n, photoHash: PH });
    const evil: Instruction = {
      ...ix,
      accounts: ix.accounts.map((a, i) => (i === 2 ? { address: relayer.address, role: AccountRole.WRITABLE } : a)),
    };
    await expectReject([evil], /relayer may only be used as fee payer/);
  });

  it('oracle/cranker instructions are not relayable', async () => {
    const attest = await getAttestInstruction({
      programAddress: PROGRAM,
      oracle: teacher,
      teacher: teacher.address,
      day: DAY,
      idx: 0,
      flags: 0x1f,
      headcount: 9,
    });
    await expectReject([attest], /attest cannot be relayed/);
    const roll = await getRollRecheckInstruction({
      programAddress: PROGRAM,
      cranker: relayerNoop,
      teacher: teacher.address,
      day: DAY,
      boundarySlot: 300n,
    });
    await expectReject([roll], /roll_recheck cannot be relayed/);
  });

  it('unknown chalk_chain discriminator or bad data length', async () => {
    await expectReject([{ programAddress: PROGRAM, data: new Uint8Array(8).fill(9) }], /unknown chalk_chain instruction/);
    const ix = await checkIn();
    await expectReject([{ ...ix, data: ix.data.slice(0, 20) }], /bad check_in data length/);
  });

  it.skip('ATA create for another mint, or non-idempotent Create', async () => {
    const other = await getCreateAssociatedTokenIdempotentInstruction({
      payer: relayer.address,
      owner: teacher.address,
      mint: PROGRAM,
    });
    await expectReject([other, await checkIn()], /only for the USDC mint/);
    const ata = await getCreateAssociatedTokenIdempotentInstruction({ payer: relayer.address, owner: teacher.address, mint: USDC });
    await expectReject([{ ...ata, data: new Uint8Array([0]) }, await checkIn()], /only ATA CreateIdempotent/);
  });

  it('compute unit price above the cap', async () => {
    await expectReject([cuPrice(10_000_000n), await checkIn()], /compute unit price above/);
  });

  it('no chalk_chain instruction', async () => {
    await expectReject([cuLimit(200_000)], /no chalk_chain instruction/);
  });

  it('teacher signature missing', async () => {
    await expectReject([await checkIn(createNoopSigner(teacher.address))], /Missing signature from/);
  });

  it('garbage input', () => {
    expect(checkRelayTransaction('not base64 at all!!', policy).ok).toBe(false);
    expect(checkRelayTransaction('AAAA', policy).ok).toBe(false);
    expect(checkRelayTransaction(undefined, policy).ok).toBe(false);
  });
});
