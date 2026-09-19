import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { getCheckInInstruction, getRegisterTeacherInstruction } from '../src/index.ts';

const PROGRAM = address('5QfoP2K5HQWgmwA4YVNW8uMTccx4XHd3uFk7Ajg2xUJG');
const RELAYER = address('Config1111111111111111111111111111111111111');

describe('builders compose with Kit transactions', () => {
  it('app-side: teacher signs, relayer is fee payer and signs later', async () => {
    const teacher = await generateKeyPairSigner();
    const ixs = [
      await getRegisterTeacherInstruction({ programAddress: PROGRAM, payer: RELAYER, teacher, schoolId: 1 }),
      await getCheckInInstruction({
        programAddress: PROGRAM,
        payer: RELAYER,
        teacher,
        day: 20715,
        slot: 100n,
        photoHash: new Uint8Array(32),
      }),
    ];
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(RELAYER, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash('11111111111111111111111111111111'), lastValidBlockHeight: 1000n },
        m,
      ),
      (m) => appendTransactionMessageInstructions(ixs, m),
    );
    const compiled = compileTransaction(msg);
    expect(Object.keys(compiled.signatures)).toEqual([RELAYER, teacher.address]);
    const signed = await partiallySignTransactionMessageWithSigners(msg);
    expect(signed.signatures[teacher.address]).toBeTruthy();
    expect(signed.signatures[RELAYER]).toBeNull();
    expect(getBase64EncodedWireTransaction(signed).length).toBeGreaterThan(100);
  });
});
