import { getCheckInInstruction, getRecheckInInstruction, identifyInstruction } from '@chalk/shared';
import {
  address,
  generateKeyPairSigner,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { buildRelayTx } from '../src/tx.ts';

const PROGRAM = address('5QfoP2K5HQWgmwA4YVNW8uMTccx4XHd3uFk7Ajg2xUJG');
const RELAYER = address('Config1111111111111111111111111111111111111');
const LIFETIME = { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: '1000' };

function decode(b64: string) {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(b64));
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (!('instructions' in msg) || msg.version !== 0) throw new Error('expected a v0 message');
  return { tx, msg };
}

describe('relay transaction', () => {
  it('check_in: relayer pays (unsigned), teacher signs', async () => {
    const teacher = await generateKeyPairSigner();
    const ix = await getCheckInInstruction({
      programAddress: PROGRAM,
      payer: RELAYER,
      teacher,
      day: 20715,
      slot: 123n,
      photoHash: new Uint8Array(32).fill(7),
    });
    const { tx, msg } = decode(await buildRelayTx([ix], RELAYER, LIFETIME));
    expect(msg.staticAccounts[0]).toBe(RELAYER);
    expect(Object.keys(tx.signatures)).toEqual([RELAYER, teacher.address]);
    expect(tx.signatures[RELAYER]).toBeNull();
    expect(tx.signatures[teacher.address]).toBeInstanceOf(Uint8Array);
    expect(msg.instructions).toHaveLength(1);
    expect(identifyInstruction(new Uint8Array(msg.instructions[0]!.data!))).toBe('check_in');
  });

  it('recheck_in: same fee payer, teacher is the only program signer', async () => {
    const teacher = await generateKeyPairSigner();
    const ix = await getRecheckInInstruction({ programAddress: PROGRAM, teacher, day: 20715, slot: 200, photoHash: new Uint8Array(32) });
    const { tx, msg } = decode(await buildRelayTx([ix], RELAYER, LIFETIME));
    expect(msg.header.numSignerAccounts).toBe(2);
    expect(tx.signatures[RELAYER]).toBeNull();
    expect(tx.signatures[teacher.address]).toBeTruthy();
    expect(identifyInstruction(new Uint8Array(msg.instructions[0]!.data!))).toBe('recheck_in');
  });
});
