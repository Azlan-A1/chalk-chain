import {
  assertIsFullySignedTransaction,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
  type Address,
  type KeyPairSigner,
  type Transaction,
} from '@solana/kit';
import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  INSTRUCTION_DATA_SIZES,
  fromBase64,
  identifyInstruction,
  type InstructionName,
} from '@chalk/shared';

// POST /relay policy: the relayer only pays for the teacher-side instructions of chalk_chain.

export interface RelayPolicy {
  relayer: Address;
  programId: Address;
  usdcMint: Address | null;
  maxCuPriceMicroLamports?: bigint;
}

export const RELAYABLE: ReadonlySet<InstructionName> = new Set(['register_teacher', 'check_in', 'recheck_in']);
/** Instructions whose account 0 is a `payer` the relayer may fill. */
const RELAYER_PAYS: ReadonlySet<InstructionName> = new Set(['register_teacher', 'check_in']);
export const DEFAULT_MAX_CU_PRICE = 100_000n;

export type RelayCheck =
  | { ok: true; tx: Transaction; instructions: InstructionName[] }
  | { ok: false; reason: string };

const reject = (reason: string): RelayCheck => ({ ok: false, reason });

function u64le(data: Uint8Array | ArrayLike<number>, offset: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[offset + i] ?? 0);
  return v;
}

export function checkRelayTransaction(wireBase64: unknown, policy: RelayPolicy): RelayCheck {
  if (typeof wireBase64 !== 'string' || wireBase64.length === 0) return reject('Body must be {"tx": "<base64>"}');
  let tx: Transaction;
  let msg: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>['decode']>;
  try {
    tx = getTransactionDecoder().decode(fromBase64(wireBase64));
    msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  } catch (e) {
    return reject(`Not a valid transaction: ${(e as Error).message}`);
  }

  if (msg.version !== 0 && msg.version !== 'legacy') return reject(`Transaction version ${msg.version} is not supported`);
  if ('addressTableLookups' in msg && (msg.addressTableLookups?.length ?? 0) > 0) {
    return reject('Address lookup tables are not allowed');
  }
  const keys = msg.staticAccounts;
  if (keys[0] !== policy.relayer) return reject('Fee payer must be the relayer');
  if (keys.lastIndexOf(policy.relayer) !== 0) return reject('Relayer appears more than once');

  const maxPrice = policy.maxCuPriceMicroLamports ?? DEFAULT_MAX_CU_PRICE;
  const names: InstructionName[] = [];

  for (const [n, ix] of msg.instructions.entries()) {
    const program = keys[ix.programAddressIndex];
    const accounts = ix.accountIndices ?? [];
    const data = ix.data ?? new Uint8Array();
    if (!program || accounts.some((i) => i >= keys.length)) return reject(`Instruction ${n}: bad account index`);

    let relayerMayPay = false;
    if (program === policy.programId) {
      const name = identifyInstruction(data);
      if (!name) return reject(`Instruction ${n}: unknown chalk_chain instruction`);
      if (!RELAYABLE.has(name)) return reject(`Instruction ${n}: ${name} cannot be relayed`);
      if (data.length !== INSTRUCTION_DATA_SIZES[name]) return reject(`Instruction ${n}: bad ${name} data length`);
      relayerMayPay = RELAYER_PAYS.has(name);
      names.push(name);
    } else if (program === COMPUTE_BUDGET_PROGRAM_ADDRESS) {
      if (accounts.length > 0) return reject(`Instruction ${n}: compute budget takes no accounts`);
      const kind = data[0];
      if (kind === 2 && data.length === 5) {
        // SetComputeUnitLimit
      } else if (kind === 3 && data.length === 9) {
        if (u64le(data, 1) > maxPrice) return reject(`Instruction ${n}: compute unit price above ${maxPrice}`);
      } else {
        return reject(`Instruction ${n}: only SetComputeUnitLimit/SetComputeUnitPrice are allowed`);
      }
    } else {
      return reject(`Instruction ${n}: program ${program} is not allowed`);
    }

    for (const [pos, i] of accounts.entries()) {
      if (i === 0 && !(relayerMayPay && pos === 0)) {
        return reject(`Instruction ${n}: relayer may only be used as fee payer or rent payer`);
      }
    }
  }

  if (names.length === 0) return reject('Transaction has no chalk_chain instruction');
  for (const [addr, sig] of Object.entries(tx.signatures)) {
    if (addr !== policy.relayer && !sig) return reject(`Missing signature from ${addr}`);
  }
  return { ok: true, tx, instructions: names };
}

/** Adds the relayer's fee-payer signature; throws if any other signature is still missing. */
export async function cosign(tx: Transaction, relayer: KeyPairSigner) {
  const signed = await partiallySignTransaction([relayer.keyPair], tx);
  assertIsFullySignedTransaction(signed);
  return {
    tx: signed,
    wire: getBase64EncodedWireTransaction(signed),
    signature: getSignatureFromTransaction(signed),
  };
}
