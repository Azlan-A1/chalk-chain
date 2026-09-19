import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createKeyPairSignerFromBytes, type KeyPairSigner } from '@solana/kit';

// Config sources: env vars, shared/deploy.json (SPEC §5), keys/{admin,relayer,oracle}.json.

export const ROOT = resolve(import.meta.dirname, '../..');
export const PORT = Number(process.env.PORT ?? 8787);
export const VISION_URL = (process.env.VISION_URL ?? 'http://127.0.0.1:8001').replace(/\/$/, '');
export const DEFAULT_RPC_URL = 'http://127.0.0.1:8899';
/** CHALK_RATE_LIMIT=0 turns off the per-IP limits on POST routes. */
export const RATE_LIMIT = process.env.CHALK_RATE_LIMIT !== '0';
/** CHALK_AUTO_ROLL=1 starts the roll_recheck cranker; CHALK_AUTO_ROLL_MS is its poll interval. */
export const AUTO_ROLL = process.env.CHALK_AUTO_ROLL === '1';
export const AUTO_ROLL_MS = Math.max(500, Number(process.env.CHALK_AUTO_ROLL_MS) || 3000);

export interface Paths {
  deploy: string;
  keys: string;
}

export function defaultPaths(): Paths {
  return {
    deploy: process.env.CHALK_DEPLOY ?? join(ROOT, 'shared/deploy.json'),
    keys: process.env.CHALK_KEYS_DIR ?? join(ROOT, 'keys'),
  };
}

export interface Deploy {
  cluster: string;
  rpcUrl: string;
  programId?: string;
  usdcMint?: string;
  relayer?: string;
  oracle?: string;
}

export type KeyName = 'admin' | 'relayer' | 'oracle';

/** Missing or incomplete setup. Routes answer 503 with this message instead of crashing. */
export class SetupError extends Error {}

export function readDeploy(path: string): Deploy {
  if (!existsSync(path)) {
    throw new SetupError(
      `${path} not found. Run \`pnpm --filter backend admin keygen\` and deploy the program (scripts/setup-*.sh) first.`,
    );
  }
  let d: Partial<Deploy>;
  try {
    d = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new SetupError(`${path} is not valid JSON: ${(e as Error).message}`);
  }
  return {
    ...d,
    cluster: d.cluster ?? 'localnet',
    rpcUrl: process.env.CHALK_RPC_URL ?? d.rpcUrl ?? DEFAULT_RPC_URL,
  };
}

/** Merges `patch` into deploy.json (creating it if needed). */
export function writeDeploy(path: string, patch: Partial<Deploy>): Deploy {
  const current: Partial<Deploy> = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const next = { cluster: 'localnet', rpcUrl: DEFAULT_RPC_URL, ...current, ...patch } as Deploy;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n');
  return next;
}

export const keyPath = (dir: string, name: KeyName) => join(dir, `${name}.json`);

/** Loads a 64-byte solana-keygen style JSON keypair. */
export async function loadSigner(dir: string, name: KeyName): Promise<KeyPairSigner> {
  const path = keyPath(dir, name);
  if (!existsSync(path)) {
    throw new SetupError(`${path} not found. Run \`pnpm --filter backend admin keygen\`.`);
  }
  const bytes = Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]);
  if (bytes.length !== 64) throw new SetupError(`${path} must hold a 64-byte keypair`);
  return createKeyPairSignerFromBytes(bytes);
}

export function isLocalnet(d: Deploy): boolean {
  return d.cluster === 'localnet' && /\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:|\/|$)/.test(d.rpcUrl);
}
