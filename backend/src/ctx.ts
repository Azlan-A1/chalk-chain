import { existsSync, statSync } from 'node:fs';
import { address, createSolanaRpc, isAddress, type Address, type KeyPairSigner } from '@solana/kit';
import { SetupError, loadSigner, readDeploy, type Deploy, type Paths } from './env.ts';
import type { Rpc } from './tx.ts';

export interface Ctx {
  deploy: Deploy;
  rpc: Rpc;
  programId: Address;
  usdcMint: Address | null;
  relayer: KeyPairSigner;
  oracle: KeyPairSigner;
  warnings: string[];
}

export function requireAddress(d: Deploy, field: 'programId' | 'usdcMint', hint: string): Address {
  const v = d[field];
  if (!v) throw new SetupError(`shared/deploy.json has no ${field}. ${hint}`);
  if (!isAddress(v)) throw new SetupError(`shared/deploy.json ${field} is not a valid address: ${v}`);
  return address(v);
}

export async function loadCtx(paths: Paths): Promise<Ctx> {
  const deploy = readDeploy(paths.deploy);
  const programId = requireAddress(deploy, 'programId', 'Deploy the program and record its ID.');
  const usdcMint = deploy.usdcMint && isAddress(deploy.usdcMint) ? address(deploy.usdcMint) : null;
  const [relayer, oracle] = await Promise.all([loadSigner(paths.keys, 'relayer'), loadSigner(paths.keys, 'oracle')]);
  const warnings: string[] = [];
  if (!usdcMint) warnings.push('usdcMint not set: run `admin create-mint`');
  if (deploy.relayer && deploy.relayer !== relayer.address) warnings.push(`deploy.json relayer ${deploy.relayer} != keys/relayer.json ${relayer.address}`);
  if (deploy.oracle && deploy.oracle !== oracle.address) warnings.push(`deploy.json oracle ${deploy.oracle} != keys/oracle.json ${oracle.address}`);
  return { deploy, rpc: createSolanaRpc(deploy.rpcUrl), programId, usdcMint, relayer, oracle, warnings };
}

/** Caches a successful load until deploy.json changes; retries on failure so the server recovers once setup is done. */
export function ctxLoader(paths: Paths): () => Promise<Ctx> {
  let cached: Promise<Ctx> | null = null;
  let stamp = -1;
  return () => {
    const now = existsSync(paths.deploy) ? statSync(paths.deploy).mtimeMs : -1;
    if (!cached || now !== stamp) {
      stamp = now;
      const p = loadCtx(paths);
      cached = p;
      p.catch(() => {
        if (cached === p) cached = null;
      });
    }
    return cached;
  };
}
