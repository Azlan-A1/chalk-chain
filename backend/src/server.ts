import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { ctxLoader } from './ctx.ts';
import { AUTO_ROLL, AUTO_ROLL_MS, PORT, RATE_LIMIT, SetupError, VISION_URL, defaultPaths } from './env.ts';

const paths = defaultPaths();
const getCtx = ctxLoader(paths);
const app = createApp({ paths, getCtx });

serve({ fetch: app.fetch, port: PORT, hostname: process.env.HOST ?? '0.0.0.0' }, async (info) => {
  console.log(`chalk backend on http://localhost:${info.port} (vision ${VISION_URL})`);
  console.log(`  auto-roll ${AUTO_ROLL ? `on, every ${AUTO_ROLL_MS} ms` : 'off'}  rate limits ${RATE_LIMIT ? 'on' : 'off'}`);
  try {
    const ctx = await getCtx();
    console.log(`  rpc ${ctx.deploy.rpcUrl}  program ${ctx.programId}`);
    console.log(`  relayer ${ctx.relayer.address}  oracle ${ctx.oracle.address}  usdc ${ctx.usdcMint ?? '(none)'}`);
    for (const w of ctx.warnings) console.warn(`  warning: ${w}`);
  } catch (e) {
    if (!(e instanceof SetupError)) throw e;
    console.warn(`  NOT CONFIGURED: ${e.message}\n  Chain routes answer 503 until this is fixed (no restart needed).`);
  }
});
