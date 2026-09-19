# app: Chalk Chain teacher PWA

React + Vite 8 + TypeScript. Talks only to the backend (SPEC §4); no direct RPC.

```sh
pnpm install
pnpm --filter app dev            # http://localhost:5173, /api proxied to http://localhost:8787
pnpm --filter app test           # vitest: countdown math, word chaining, relay tx shape, routes, photo purge, explorer URL
pnpm --filter app build          # tsc + vite build → app/dist
```

**On a phone.** The camera and WebCrypto both need HTTPS:

```sh
VITE_HTTPS=1 pnpm --filter app dev --host    # open https://<laptop-ip>:5173 and accept the self-signed cert
```

**Backend URL.**
- Default: the app calls same-origin `/api/*`, and the Vite dev/preview server proxies that to `BACKEND_PROXY_TARGET` (default `http://localhost:8787`). This keeps a phone on HTTPS from being blocked for mixed content.
- `VITE_BACKEND_URL=https://…` sets an absolute URL instead. The backend then needs CORS open.
- A production build without `VITE_BACKEND_URL` falls back to `http://localhost:8787`.

**No backend yet?** `node app/dev/mock-backend.ts` starts an in-memory stand-in on :8787. It uses `@chalk/shared` to apply check_in/recheck_in to fake Day accounts, and it does not verify signatures. Knobs:
- `SLOT_LAG=224` makes `/slot` serve nearly expired words, to exercise the SlotTooOld path.
- `FAIL_CHECK=people` makes the People check fail.

**Teacher key.**
- Generated once with Kit and kept in IndexedDB as a non-extractable `CryptoKeyPair`. It is never shown.
- Browsers without native Ed25519 load `@solana/webcrypto-ed25519-polyfill`. Polyfilled keys can't be stored in IndexedDB, so on those browsers the 32-byte seed is stored instead.
- "Reset teacher" in the Demo panel deletes the key, and the next load creates a new teacher.

**Public proof page.** `#/t/<wallet>` (today) or `#/t/<wallet>/<day>`, optional `?lang=sw`. It needs no teacher key and only reads `GET /health`, `/teacher/:wallet` and `/day/:wallet/:day`. It shows the chain, checks, head count, re-checks, the USDC paid, an Explorer link to the Day PDA and the 3 days before. Today's page refreshes every 5 s until the day is settled. Home's *Share today's proof* shares or copies the link.

**Unverified photos.** After `/relay` lands, the exact committed JPEG bytes go into IndexedDB (`chalk-chain-photos`, key `teacher:day:idx`). They're deleted once `/verify` succeeds, when the link shows as attested, or when the day is settled. Any on-chain link that isn't checked yet shows *Check again* on Home. Photos older than 2 days are purged on boot.

Files:
- `src/api.ts`: backend client
- `src/logic.ts`: pure helpers
- `src/tx.ts`: v0 tx with the relayer as fee payer, partially signed by the teacher
- `src/flow.ts`: register / check-in orchestration
- `src/key.ts`: IndexedDB key storage
- `src/photo.ts`: downscale to 1600 px, then hash
- `src/photos.ts`: IndexedDB store of committed-but-unverified photos
- `src/storage.ts`: localStorage conveniences
- Screens: `Setup`, `Home`, `CheckIn`, `Proof` (public, hash-routed in `App.tsx` `Root`), plus the re-check alert in `App`
