import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Base64EncodedWireTransaction,
  type Instruction,
  type Rpc as KitRpc,
  type SolanaRpcApi,
  type Signature,
  type TransactionSigner,
} from '@solana/kit';
import { fromBase64 } from '@chalk/shared';

export type Rpc = KitRpc<SolanaRpcApi>;

export interface Landed {
  signature: Signature;
  slot: bigint;
  logs: string[];
}

/** A transaction that landed with an error; `err` and `logs` feed the shared error extractor. */
export class TxError extends Error {
  readonly signature: string;
  readonly err: unknown;
  readonly logs: string[];
  constructor(signature: string, err: unknown, logs: string[]) {
    super(`Transaction ${signature} failed: ${JSON.stringify(err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
    this.signature = signature;
    this.err = err;
    this.logs = logs;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sends a signed wire transaction (with preflight) and waits until it is confirmed. */
export async function sendAndConfirmWire(
  rpc: Rpc,
  wire: Base64EncodedWireTransaction,
  signature: Signature,
  timeoutMs = 45_000,
): Promise<Landed> {
  await rpc.sendTransaction(wire, { encoding: 'base64', preflightCommitment: 'confirmed' }).send();
  return confirmSignature(rpc, signature, timeoutMs);
}

/** Polls signature status until `confirmed`; throws TxError if it landed with an error. */
export async function confirmSignature(rpc: Rpc, signature: Signature, timeoutMs = 45_000): Promise<Landed> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const st = value[0];
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
      const logs = await fetchLogs(rpc, signature);
      if (st.err) throw new TxError(signature, st.err, logs);
      return { signature, slot: st.slot, logs };
    }
    if (Date.now() > deadline) throw new Error(`Transaction ${signature} was not confirmed in ${timeoutMs / 1000}s`);
    await sleep(400);
  }
}

async function fetchLogs(rpc: Rpc, signature: Signature): Promise<string[]> {
  for (let i = 0; i < 5; i++) {
    const tx = await rpc
      .getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'json' })
      .send();
    if (tx) return [...(tx.meta?.logMessages ?? [])];
    await sleep(300);
  }
  return [];
}

/** Builds a v0 transaction with `feePayer`, signs with every signer attached to the instructions, sends, confirms. */
export async function sendInstructions(
  rpc: Rpc,
  feePayer: TransactionSigner,
  instructions: readonly Instruction[],
): Promise<Landed> {
  const { value: latest } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await signTransactionMessageWithSigners(msg);
  return sendAndConfirmWire(rpc, getBase64EncodedWireTransaction(signed), getSignatureFromTransaction(signed));
}

/** Raw account data at `confirmed`, or null if the account does not exist. */
export async function fetchData(rpc: Rpc, address: Address): Promise<Uint8Array | null> {
  const { value } = await rpc.getAccountInfo(address, { encoding: 'base64', commitment: 'confirmed' }).send();
  return value ? fromBase64(value.data[0]) : null;
}

const DEFAULT_SLOT_MS = 400;
let slotMsCache: { at: number; value: number } | null = null;

/**
 * Average slot time in ms: block times over the last ~150 slots, else performance samples, else 400.
 * (Surfpool's performance samples always say 1 slot/s, so block times come first.) Cached 30 s.
 */
export async function measureSlotMs(rpc: Rpc): Promise<number> {
  if (slotMsCache && Date.now() - slotMsCache.at < 30_000) return slotMsCache.value;
  let value = DEFAULT_SLOT_MS;
  try {
    const now = await rpc.getSlot({ commitment: 'confirmed' }).send();
    const span = now > 151n ? 150n : now - 1n;
    const [t1, t0] =
      span >= 25n
        ? await Promise.all([rpc.getBlockTime(now).send(), rpc.getBlockTime(now - span).send()])
        : [null, null];
    if (t1 !== null && t0 !== null && t1 > t0) {
      value = Math.round((Number(t1 - t0) * 1000) / Number(span));
    } else {
      const samples = await rpc.getRecentPerformanceSamples(10).send();
      const slots = samples.reduce((n, s) => n + Number(s.numSlots), 0);
      const secs = samples.reduce((n, s) => n + s.samplePeriodSecs, 0);
      if (slots >= 50 && secs > 0) value = Math.round((secs * 1000) / slots);
    }
  } catch {
    // keep the default
  }
  slotMsCache = { at: Date.now(), value };
  return value;
}
