import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  address,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  generateKeyPairSigner,
  isAddress,
  lamports,
  type Address,
  type KeyPairSigner,
} from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import { getInitializeMint2Instruction, getMintSize, getMintToInstruction } from '@solana-program/token';
import {
  TOKEN_PROGRAM_ADDRESS,
  USDC_DECIMALS,
  addressBytes,
  decodeConfig,
  findConfigPda,
  findVaultAta,
  findVaultAuthorityPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitConfigInstruction,
  getUpdateConfigInstruction,
  toJsonSafe,
  type ConfigArgs,
} from '@chalk/shared';
import { requireAddress } from './ctx.ts';
import { defaultConfigArgs, parseUsdc } from './defaults.ts';
import {
  ROOT,
  SetupError,
  defaultPaths,
  isLocalnet,
  keyPath,
  loadSigner,
  readDeploy,
  writeDeploy,
  type Deploy,
  type KeyName,
} from './env.ts';
import { confirmSignature, fetchData, measureSlotMs, sendInstructions, type Rpc } from './tx.ts';

const USAGE = `Usage: pnpm --filter backend admin <command> [options]

  keygen                 create keys/{admin,relayer,oracle}.json if missing; record them in shared/deploy.json
  airdrop [--sol 5] [--to <addr>]   localnet only: fund admin, relayer, oracle (and --to)
  create-mint [--force]  new 6-decimal SPL mint (authority = admin); writes usdcMint to deploy.json
  init-config [opts]     init_config with defaults from the measured slot time
  update-config [opts]   update_config: current values overridden by opts
  fund-vault <amountUsdc>  mint USDC into the vault ATA
  status                 config, vault balance, SOL balances

Config opts: --window-slots N --recheck-window-slots N --recheck-interval-slots N --bonus-per-link N
             --recheck-threshold N --max-links N --min-headcount N --oracle <addr> --slot-ms N`;

const paths = defaultPaths();
const KEY_NAMES: KeyName[] = ['admin', 'relayer', 'oracle'];

const { positionals, values: opts } = parseArgs({
  allowPositionals: true,
  options: {
    sol: { type: 'string' },
    to: { type: 'string', multiple: true },
    force: { type: 'boolean' },
    'window-slots': { type: 'string' },
    'recheck-window-slots': { type: 'string' },
    'recheck-interval-slots': { type: 'string' },
    'bonus-per-link': { type: 'string' },
    'recheck-threshold': { type: 'string' },
    'max-links': { type: 'string' },
    'min-headcount': { type: 'string' },
    oracle: { type: 'string' },
    'slot-ms': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

function rpcFor(d: Deploy): Rpc {
  return createSolanaRpc(d.rpcUrl);
}

function intOpt(name: keyof typeof opts, max: number): number | undefined {
  const v = opts[name];
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`--${name} must be an integer 0..${max}`);
  return n;
}
function bigOpt(name: keyof typeof opts): bigint | undefined {
  const v = opts[name];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !/^\d+$/.test(v)) throw new Error(`--${name} must be a non-negative integer`);
  return BigInt(v);
}

const fmtUsdc = (base: bigint) => `${base / 1_000_000n}.${(base % 1_000_000n).toString().padStart(6, '0')}`;
const fmtSol = (l: bigint) => (Number(l) / 1e9).toFixed(4);

// ---- commands ----

async function keygen() {
  mkdirSync(paths.keys, { recursive: true });
  const addrs = {} as Record<KeyName, Address>;
  for (const name of KEY_NAMES) {
    const p = keyPath(paths.keys, name);
    if (!existsSync(p)) {
      const seed = crypto.getRandomValues(new Uint8Array(32));
      const s = await createKeyPairSignerFromPrivateKeyBytes(seed);
      writeFileSync(p, JSON.stringify([...seed, ...addressBytes(s.address)]));
      chmodSync(p, 0o600);
      console.log(`created ${p}`);
    }
    addrs[name] = (await loadSigner(paths.keys, name)).address;
    console.log(`${name.padEnd(8)} ${addrs[name]}`);
  }
  const patch: Partial<Deploy> = { relayer: addrs.relayer, oracle: addrs.oracle };
  const current = existsSync(paths.deploy) ? readDeploy(paths.deploy) : null;
  if (!current?.programId) {
    const id = programIdFromAnchorToml();
    if (id) {
      patch.programId = id;
      console.log(`programId ${id} (from program/Anchor.toml)`);
    }
  }
  writeDeploy(paths.deploy, patch);
  console.log(`wrote ${paths.deploy}`);
}

function programIdFromAnchorToml(): string | null {
  const toml = join(ROOT, 'program/Anchor.toml');
  if (!existsSync(toml)) return null;
  const m = /\[programs\.localnet\][^[]*?chalk_chain\s*=\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/.exec(readFileSync(toml, 'utf8'));
  return m?.[1] ?? null;
}

async function airdrop() {
  const d = readDeploy(paths.deploy);
  if (!isLocalnet(d)) throw new Error(`airdrop is localnet only (cluster=${d.cluster}, rpc=${d.rpcUrl})`);
  const rpc = rpcFor(d);
  const amount = lamports(BigInt(Math.round(Number(opts.sol ?? '5') * 1e9)));
  const targets: Address[] = [];
  for (const n of KEY_NAMES) targets.push((await loadSigner(paths.keys, n)).address);
  for (const t of opts.to ?? []) {
    if (!isAddress(t)) throw new Error(`--to ${t} is not an address`);
    targets.push(address(t));
  }
  for (const t of targets) {
    const sig = await rpc.requestAirdrop(t, amount).send();
    await confirmSignature(rpc, sig);
    const { value } = await rpc.getBalance(t, { commitment: 'confirmed' }).send();
    console.log(`${t}  ${fmtSol(value)} SOL`);
  }
}

async function createMint() {
  const d = readDeploy(paths.deploy);
  const rpc = rpcFor(d);
  if (d.usdcMint && !opts.force && (await fetchData(rpc, address(d.usdcMint)))) {
    console.log(`usdcMint ${d.usdcMint} already exists (pass --force to make a new one)`);
    return;
  }
  const admin = await loadSigner(paths.keys, 'admin');
  const mint = await generateKeyPairSigner();
  const space = getMintSize();
  const rent = await rpc.getMinimumBalanceForRentExemption(BigInt(space)).send();
  const landed = await sendInstructions(rpc, admin, [
    getCreateAccountInstruction({ payer: admin, newAccount: mint, lamports: rent, space, programAddress: TOKEN_PROGRAM_ADDRESS }),
    getInitializeMint2Instruction({ mint: mint.address, decimals: USDC_DECIMALS, mintAuthority: admin.address }),
  ]);
  writeDeploy(paths.deploy, { usdcMint: mint.address });
  console.log(`usdcMint ${mint.address}  (tx ${landed.signature})`);
}

async function currentConfigArgs(rpc: Rpc, programId: Address): Promise<ConfigArgs | null> {
  const [pda] = await findConfigPda(programId);
  const data = await fetchData(rpc, pda);
  if (!data) return null;
  const c = decodeConfig(data);
  return {
    oracle: c.oracle,
    windowSlots: c.windowSlots,
    recheckWindowSlots: c.recheckWindowSlots,
    recheckIntervalSlots: c.recheckIntervalSlots,
    bonusPerLink: c.bonusPerLink,
    recheckThreshold: c.recheckThreshold,
    maxLinks: c.maxLinks,
    minHeadcount: c.minHeadcount,
  };
}

function withOverrides(base: ConfigArgs): ConfigArgs {
  const oracle = opts.oracle;
  if (oracle !== undefined && !isAddress(oracle)) throw new Error(`--oracle ${oracle} is not an address`);
  return {
    oracle: oracle ? address(oracle) : base.oracle,
    windowSlots: bigOpt('window-slots') ?? base.windowSlots,
    recheckWindowSlots: bigOpt('recheck-window-slots') ?? base.recheckWindowSlots,
    recheckIntervalSlots: bigOpt('recheck-interval-slots') ?? base.recheckIntervalSlots,
    bonusPerLink: bigOpt('bonus-per-link') ?? base.bonusPerLink,
    recheckThreshold: intOpt('recheck-threshold', 255) ?? base.recheckThreshold,
    maxLinks: intOpt('max-links', 6) ?? base.maxLinks,
    minHeadcount: intOpt('min-headcount', 255) ?? base.minHeadcount,
  };
}

function printArgs(a: ConfigArgs) {
  console.log(JSON.stringify(toJsonSafe(a), null, 2));
}

async function initConfig() {
  const d = readDeploy(paths.deploy);
  const rpc = rpcFor(d);
  const programId = requireAddress(d, 'programId', 'Deploy the program first.');
  const usdcMint = requireAddress(d, 'usdcMint', 'Run `admin create-mint` first.');
  if (await currentConfigArgs(rpc, programId)) {
    console.log('config already initialized; use update-config');
    return;
  }
  const [admin, oracle] = await Promise.all([loadSigner(paths.keys, 'admin'), loadSigner(paths.keys, 'oracle')]);
  const slotMs = opts['slot-ms'] ? Number(opts['slot-ms']) : await measureSlotMs(rpc);
  const args = withOverrides(defaultConfigArgs(oracle.address, slotMs));
  console.log(`slot time ${slotMs} ms`);
  const wantedWindow = Math.ceil(150_000 / slotMs);
  if (BigInt(wantedWindow) > args.windowSlots) {
    console.log(
      `window capped at ${args.windowSlots} slots (~${Math.round((Number(args.windowSlots) * slotMs) / 1000)} s): ` +
        `SlotHashes only keeps 512 slots, so a longer window could not be proven`,
    );
  }
  printArgs(args);
  const ix = await getInitConfigInstruction({ programAddress: programId, admin, usdcMint, args });
  const landed = await sendInstructions(rpc, admin, [ix]);
  console.log(`init_config ${landed.signature}`);
}

async function updateConfig() {
  const d = readDeploy(paths.deploy);
  const rpc = rpcFor(d);
  const programId = requireAddress(d, 'programId', 'Deploy the program first.');
  const current = await currentConfigArgs(rpc, programId);
  if (!current) throw new SetupError('config not initialized; run init-config');
  const admin = await loadSigner(paths.keys, 'admin');
  const args = withOverrides(current);
  printArgs(args);
  const ix = await getUpdateConfigInstruction({ programAddress: programId, admin, args });
  const landed = await sendInstructions(rpc, admin, [ix]);
  console.log(`update_config ${landed.signature}`);
}

async function fundVault(amountArg: string | undefined) {
  if (!amountArg) throw new Error('usage: fund-vault <amountUsdc>');
  const amount = parseUsdc(amountArg);
  const d = readDeploy(paths.deploy);
  const rpc = rpcFor(d);
  const programId = requireAddress(d, 'programId', 'Deploy the program first.');
  const usdcMint = requireAddress(d, 'usdcMint', 'Run `admin create-mint` first.');
  const admin = await loadSigner(paths.keys, 'admin');
  const [[vaultAuthority], [vault]] = await Promise.all([findVaultAuthorityPda(programId), findVaultAta(programId, usdcMint)]);
  const landed = await sendInstructions(rpc, admin, [
    await getCreateAssociatedTokenIdempotentInstruction({ payer: admin, owner: vaultAuthority, mint: usdcMint }),
    getMintToInstruction({ mint: usdcMint, token: vault, mintAuthority: admin, amount }),
  ]);
  const { value } = await rpc.getTokenAccountBalance(vault, { commitment: 'confirmed' }).send();
  console.log(`minted ${fmtUsdc(amount)} USDC to vault ${vault}; balance ${value.uiAmountString}  (tx ${landed.signature})`);
}

async function status() {
  const d = readDeploy(paths.deploy);
  const rpc = rpcFor(d);
  console.log(`deploy  ${paths.deploy}`);
  console.log(JSON.stringify(d, null, 2));
  try {
    console.log(`slot    ${await rpc.getSlot({ commitment: 'confirmed' }).send()}  (slot time ${await measureSlotMs(rpc)} ms)`);
  } catch (e) {
    console.log(`rpc     unreachable at ${d.rpcUrl}: ${(e as Error).message}`);
    return;
  }
  for (const n of KEY_NAMES) {
    let s: KeyPairSigner;
    try {
      s = await loadSigner(paths.keys, n);
    } catch (e) {
      console.log(`${n.padEnd(8)} ${(e as Error).message}`);
      continue;
    }
    const { value } = await rpc.getBalance(s.address, { commitment: 'confirmed' }).send();
    console.log(`${n.padEnd(8)} ${s.address}  ${fmtSol(value)} SOL`);
  }
  if (!d.programId) return console.log('programId: not set');
  const programId = address(d.programId);
  const [configPda] = await findConfigPda(programId);
  const data = await fetchData(rpc, configPda);
  console.log(`config  ${configPda}`);
  console.log(data ? JSON.stringify(toJsonSafe(decodeConfig(data)), null, 2) : '  (not initialized)');
  if (!d.usdcMint) return console.log('usdcMint: not set');
  const [vault] = await findVaultAta(programId, address(d.usdcMint));
  try {
    const { value } = await rpc.getTokenAccountBalance(vault, { commitment: 'confirmed' }).send();
    console.log(`vault   ${vault}  ${value.uiAmountString} USDC`);
  } catch {
    console.log(`vault   ${vault}  (not created)`);
  }
}

async function main() {
  const [cmd, ...rest] = positionals;
  if (!cmd || opts.help) return console.log(USAGE);
  switch (cmd) {
    case 'keygen': return keygen();
    case 'airdrop': return airdrop();
    case 'create-mint': return createMint();
    case 'init-config': return initConfig();
    case 'update-config': return updateConfig();
    case 'fund-vault': return fundVault(rest[0]);
    case 'status': return status();
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  const logs = (e as { logs?: string[]; context?: { logs?: string[] } }).logs ?? (e as { context?: { logs?: string[] } }).context?.logs;
  if (logs?.length) console.error(logs.join('\n'));
  process.exitCode = 1;
});
