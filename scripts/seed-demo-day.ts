/**
 * Create one honest, fully verified school day on the running chain, for screenshots and for
 * rehearsing the proof page without a phone.
 *
 *   pnpm --filter @chalk/scripts exec tsx seed-demo-day.ts [--links 2] [--settle]
 *
 * It acts exactly like the app: teacher key signs, relayer pays, photos go through /verify.
 */
import { generateKeyPairSigner } from '@solana/kit';
import { api, commitLink, getDay, photo, post, register, rnd, sleep, verify } from './client.ts';
import { dayNumber } from '@chalk/shared';

const args = process.argv.slice(2);
const links = Number(args[args.indexOf('--links') + 1]) || 2;
const settle = args.includes('--settle');

async function main() {
  const { body: health } = await api('/health');
  const relayer = health.relayer as `${string}`;
  const teacher = await generateKeyPairSigner();
  const day = dayNumber();

  const r = await register(teacher, relayer as never, 5000);
  if (r.status !== 200) throw new Error(`register: ${JSON.stringify(r.body)}`);
  console.log(`teacher ${teacher.address}`);

  let lastCommit: Uint8Array | null = null;
  const onBoard: string[] = []; // a real board keeps every earlier line
  for (let idx = 0; idx < links; idx++) {
    if (idx > 0) {
      const t = await post('/recheck', { teacher: teacher.address, day });
      if (t.status !== 200) throw new Error(`recheck: ${JSON.stringify(t.body)}`);
      await sleep(1500);
    }
    const seed = rnd();
    const { res, words, image } = await commitLink({
      teacher,
      relayer: relayer as never,
      day,
      lastCommit,
      seed,
      imageFor: (w) => photo([...onBoard, ...w], seed),
    });
    onBoard.push(...words);
    if (res.status !== 200) throw new Error(`link ${idx}: ${JSON.stringify(res.body)}`);
    const v = await verify(teacher.address, day, idx, image);
    console.log(`  link ${idx}: ${words.join(' · ')} -> ${v.body?.passes ? 'passes' : 'FAILS'} (${v.body?.reasons?.join('; ')})`);
    lastCommit = (await getDay(teacher.address, day)).day.links[idx]!.commit;
  }

  if (settle) {
    const s = await post('/settle', { teacher: teacher.address, day });
    console.log(`  settled: ${JSON.stringify(s.body)}`);
  }
  console.log(`\nproof page: /#/t/${teacher.address}/${day}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
