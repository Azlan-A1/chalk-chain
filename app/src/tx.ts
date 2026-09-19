import {
  blockhash as toBlockhash,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  appendTransactionMessageInstructions,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
} from '@solana/kit';

/**
 * v0 transaction with the relayer as fee payer (it co-signs in POST /relay).
 * The teacher's signer is attached to the instructions, so only the teacher signs here.
 */
export async function buildRelayTx(
  instructions: readonly Instruction[],
  relayer: Address,
  lifetime: { blockhash: string; lastValidBlockHeight: number | string | bigint },
): Promise<string> {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(createNoopSigner(relayer), m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: toBlockhash(lifetime.blockhash), lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight) },
        m,
      ),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await partiallySignTransactionMessageWithSigners(msg);
  return getBase64EncodedWireTransaction(signed);
}
