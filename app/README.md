# app: Chalk Chain teacher PWA

React + Vite 8 + TypeScript. Talks only to the backend (SPEC §4); no direct RPC.

```sh
pnpm install
pnpm --filter app dev            # http://localhost:5173, /api proxied to http://localhost:8787
pnpm --filter app test           # vitest: countdown math, word chaining for link k, relay tx shape
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

Files:
- `src/api.ts`: backend client
- `src/logic.ts`: pure helpers
- `src/tx.ts`: v0 tx with the relayer as fee payer, partially signed by the teacher
- `src/flow.ts`: register / check-in orchestration
- `src/key.ts`: IndexedDB key storage
- `src/photo.ts`: downscale to 1600 px, then hash
- `src/storage.ts`: localStorage conveniences
- Screens: `Setup`, `Home`, `CheckIn`, plus the re-check alert in `App`
