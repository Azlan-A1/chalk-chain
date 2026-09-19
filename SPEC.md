# Chalk Chain — Interface Spec

This file is the contract between the four parts of the system. If code and this
spec disagree, the spec wins until the whole team agrees to change it. Byte-level
details here are checked by the test vectors in `shared/vectors/`.

```
app/      React PWA the teacher uses (P2)
backend/  Node service: fee-paying relayer, oracle, admin CLI (P1)
program/  Anchor 1.1.2 Solana program (P1)
vision/   Python FastAPI photo checks, never touches Solana (P3)
shared/   word lists, reference derivation, test vectors, TS codec
```

Toolchain: Solana CLI 3.1.10, Anchor 1.1.2 (Rust 1.98), Surfpool 1.6, Node 24, pnpm 10, Python 3.14.

---

## 1. Word derivation

All hashes are SHA-256. `‖` is byte concatenation. `teacher` is the 32-byte teacher
wallet public key. `day` is a u32 encoded little-endian (4 bytes).

```
prev_0  = sha256("chalk-chain" ‖ teacher ‖ day_le)          // "chalk-chain" = 11 ASCII bytes
seed_k  = sha256(slot_hash(S_k) ‖ teacher ‖ prev_{k-1})       // k = 1, 2, ...
words_k = [seed_k[0], seed_k[1], seed_k[2]]                   // indices into a 256-word list
prev_k  = sha256(photo_sha256_k ‖ seed_k)                     // "commit" of link k
```

- `slot_hash(S)` is the **bank hash** stored in the `SlotHashes` sysvar
  (`SysvarS1otHashes111111111111111111111111111`) for slot `S` — not the value
  returned by `getLatestBlockhash`.
- `photo_sha256` is SHA-256 of the exact image bytes the app uploads.
- Word lists: `shared/wordlists/en.json` and `sw.json`, each exactly 256 lowercase
  words. Index `i` is the word for byte `i`. The program stores only indices, so
  lists can be edited without breaking anything on-chain (but all services must
  load the same files). `sw.json` is a draft that needs a native speaker's review.
- Links are 0-indexed in storage: link index 0 uses `seed_1`/`prev_1` above.

Reference implementation: `shared/py/chalkwords.py`. Vectors: `shared/vectors/derivation.json`.

---

## 2. Program

Program name `chalk_chain`. Program ID is whatever `anchor keys sync` produces;
it is recorded in `shared/deploy.json` (see §5).

### 2.1 PDAs

| Account | Seeds |
|---|---|
| Config | `["config"]` |
| Vault authority | `["vault"]` (holds no data; owns the vault token account) |
| Vault token account | Associated token account of (vault authority, `usdc_mint`) — classic SPL Token program |
| Teacher | `["teacher", teacher_wallet]` |
| Day | `["day", teacher_wallet, day_le_u32]` |

### 2.2 Accounts (Borsh, Anchor default 8-byte discriminator = `sha256("account:<Name>")[0..8]`)

Field order below is the exact on-chain order. No padding.

```rust
pub struct Config {            // 8 + 32*3 + 8*4 + 1*5 = 141 bytes
    pub admin: Pubkey,
    pub oracle: Pubkey,
    pub usdc_mint: Pubkey,
    pub window_slots: u64,           // max age of the challenge slot at check-in
    pub recheck_window_slots: u64,   // time to answer a re-check
    pub recheck_interval_slots: u64, // boundary spacing for roll_recheck
    pub bonus_per_link: u64,         // in mint base units (6 decimals)
    pub recheck_threshold: u8,       // roll hits if roll_byte < threshold (0..=255)
    pub max_links: u8,               // <= 6
    pub min_headcount: u8,           // informational; the backend applies it
    pub bump: u8,
    pub vault_bump: u8,
}

pub struct Teacher {           // 8 + 32 + 4 + 4 + 8 + 1 = 57 bytes
    pub wallet: Pubkey,
    pub school_id: u32,
    pub days_settled: u32,
    pub total_paid: u64,
    pub bump: u8,
}

pub struct Link {              // 109 bytes
    pub slot: u64,                   // challenge slot S
    pub photo_hash: [u8; 32],
    pub seed: [u8; 32],
    pub commit: [u8; 32],            // prev_k
    pub words: [u8; 3],
    pub flags: u8,                   // set by attest
    pub headcount: u8,               // set by attest
}

pub struct Day {               // 8 + 32 + 4 + 1*6 + 8*4 + 109*6 = 736 bytes
    pub teacher: Pubkey,
    pub day: u32,
    pub n_links: u8,
    pub recheck_pending: bool,
    pub rechecks_met: u8,
    pub missed_recheck: bool,
    pub settled: bool,
    pub bump: u8,
    pub recheck_from_slot: u64,
    pub recheck_deadline_slot: u64,
    pub last_rolled_boundary: u64,
    pub paid: u64,
    pub links: [Link; 6],            // MAX_LINKS = 6
}
```

Link flag bits: `WORDS_OK=1, CHAIN_OK=2, NOT_RECAPTURE=4, NOT_REUSED=8,
PEOPLE_OK=16, ATTESTED=128`. A link **passes** when
`flags & 0b1001_1111 == 0b1001_1111` (all five checks plus ATTESTED).

### 2.3 Instructions

Discriminator = `sha256("global:<name>")[0..8]`, then Borsh args in order.
Accounts are listed in exact order with (writable, signer). `ConfigArgs` is:

```rust
pub struct ConfigArgs {
    pub oracle: Pubkey,
    pub window_slots: u64,
    pub recheck_window_slots: u64,
    pub recheck_interval_slots: u64,
    pub bonus_per_link: u64,
    pub recheck_threshold: u8,
    pub max_links: u8,
    pub min_headcount: u8,
}
```

| # | Instruction | Args | Accounts (w = writable, s = signer) |
|---|---|---|---|
| 1 | `init_config` | `args: ConfigArgs` | admin (w,s) · config PDA (w) · vault_authority PDA · usdc_mint · vault ATA (w) · token_program · associated_token_program · system_program |
| 2 | `update_config` | `args: ConfigArgs` | admin (s) · config (w) |
| 3 | `register_teacher` | `school_id: u32` | payer (w,s) · teacher (s) · teacher_account PDA (w) · system_program |
| 4 | `check_in` | `day: u32, slot: u64, photo_hash: [u8;32]` | payer (w,s) · teacher (s) · config · teacher_account · day_account PDA (w, init) · slot_hashes sysvar · system_program |
| 5 | `recheck_in` | `day: u32, slot: u64, photo_hash: [u8;32]` | teacher (s) · config · day_account (w) · slot_hashes sysvar |
| 6 | `trigger_recheck` | `day: u32` | oracle (s) · config · teacher (unchecked wallet) · day_account (w) |
| 7 | `roll_recheck` | `day: u32, boundary_slot: u64` | cranker (s) · config · teacher (unchecked wallet) · day_account (w) · slot_hashes sysvar |
| 8 | `attest` | `day: u32, idx: u8, flags: u8, headcount: u8` | oracle (s) · config · teacher (unchecked wallet) · day_account (w) |
| 9 | `settle_day` | `day: u32` | oracle (s) · config · teacher (unchecked wallet) · teacher_account (w) · day_account (w) · vault_authority PDA · vault ATA (w) · teacher_usdc ATA (w) · usdc_mint · token_program |

The fee payer of every transaction is the backend's relayer (or the oracle key for
oracle-sent transactions). `teacher_usdc` must already exist: the backend adds an
Associated Token Program `CreateIdempotent` instruction before `settle_day`.

### 2.4 Rules

Let `now = Clock::get().slot`, `clock_day = unix_timestamp / 86400`.

**Finding a slot hash.** Read the SlotHashes sysvar account data raw (it is too
large to deserialize): `u64 len` then `len × (u64 slot, [u8;32] hash)`, newest
first. Binary search for the slot. Not found → `SlotNotFound`.

**check_in** (link 0; creates the Day account)
- `day == clock_day || day + 1 == clock_day` else `DayMismatch`
- `now - slot <= window_slots` else `SlotTooOld`; slot must be in SlotHashes
- compute `prev_0`, `seed`, `words`, `commit`; store link 0; `n_links = 1`
- emit `CheckedIn { teacher, day, idx, slot, slot_age: now - slot, words }`

**recheck_in** (link k ≥ 1)
- `recheck_pending` else `NoRecheckPending`; `now <= recheck_deadline_slot` else `RecheckExpired`
- `slot >= recheck_from_slot` else `SlotBeforeRecheck`; `slot > links[n-1].slot` else `SlotNotIncreasing`
- same freshness + SlotHashes checks as check_in; `n_links < max_links` else `TooManyLinks`
- `prev` is `links[n-1].commit`; store link; `recheck_pending = false`; `rechecks_met += 1`
- emit `CheckedIn`

**trigger_recheck** (oracle only; manual/demo path)
- `!settled`, `n_links >= 1`, `!recheck_pending` else `RecheckInProgress`
- `recheck_pending = true`, `recheck_from_slot = now`, `recheck_deadline_slot = now + recheck_window_slots`
- emit `RecheckStarted { teacher, day, from_slot, deadline_slot }`

**roll_recheck** (anyone; the unpredictable path)
- `!settled`, `n_links >= 1`, `!recheck_pending`
- `boundary_slot % recheck_interval_slots == 0` else `NotABoundary`
- `boundary_slot > last_rolled_boundary` else `AlreadyRolled`; `boundary_slot > links[n-1].slot` and `boundary_slot <= now` else `BadBoundary`
- `h = slot_hash(boundary_slot)` (must be in SlotHashes); `last_rolled_boundary = boundary_slot`
- `roll = sha256(h ‖ day_account_address)[0]`; if `roll < recheck_threshold`: start a
  re-check exactly as trigger_recheck but with `recheck_from_slot = boundary_slot`,
  `recheck_deadline_slot = boundary_slot + recheck_window_slots`
- emit `RecheckRolled { teacher, day, boundary_slot, roll, hit }`

**attest** (oracle only)
- `!settled` else `AlreadySettled`; `idx < n_links` else `BadLinkIndex`
- `links[idx].flags = flags | ATTESTED`; `links[idx].headcount = headcount`
- emit `Attested { teacher, day, idx, flags, headcount }`

**settle_day** (oracle only)
- `!settled` else `AlreadySettled`
- if `recheck_pending`: if `now <= recheck_deadline_slot` → `RecheckInProgress`; else `missed_recheck = true`, `recheck_pending = false`
- `passing = count of links that pass`; `amount = (links[0] passes && !missed_recheck) ? passing * bonus_per_link : 0`
- if `amount > 0`: transfer from vault ATA to teacher_usdc, signed by vault authority PDA
- `settled = true`, `paid = amount`, teacher `days_settled += 1`, `total_paid += amount`
- emit `Settled { teacher, day, passing, missed_recheck, amount }`

### 2.5 Errors (Anchor custom codes start at 6000, in this order)

| Code | Name | Friendly text for the app |
|---|---|---|
| 6000 | SlotNotFound | "Those words expired. Get new ones." |
| 6001 | SlotTooOld | "Photo sent too late. Get new words and try again." |
| 6002 | SlotNotIncreasing | "These words are older than your last photo." |
| 6003 | SlotBeforeRecheck | "Use the new words from this re-check." |
| 6004 | DayMismatch | "Your phone's date looks wrong." |
| 6005 | TooManyLinks | "Today's chain is full." |
| 6006 | NoRecheckPending | "No re-check is open right now." |
| 6007 | RecheckExpired | "The re-check window closed." |
| 6008 | RecheckInProgress | "A re-check is still open." |
| 6009 | NotOracle | "Only the verifier can do that." |
| 6010 | AlreadySettled | "Today is already settled." |
| 6011 | BadLinkIndex | "That photo doesn't exist." |
| 6012 | NotABoundary | "Not a re-check boundary slot." |
| 6013 | AlreadyRolled | "That boundary was already rolled." |
| 6014 | BadBoundary | "Boundary slot out of range." |
| 6015 | InvalidConfig | "Invalid configuration." |

---

## 3. Vision service (P3) — `vision/`

`POST /verify` (multipart/form-data)

| Field | Type | Notes |
|---|---|---|
| `image` | file | JPEG/PNG bytes exactly as committed on-chain |
| `expected` | JSON string | 3 words for this link, e.g. `["lion","cup","rain"]` |
| `prior` | JSON string | earlier links' words, oldest first, e.g. `[["maji","jua","mti"]]` |
| `photo_id` | string | `"<teacher>:<day>:<idx>"`; used for the reuse index |
| `group_id` | string | `"<teacher>:<day>"`; photos in the same group are not compared for reuse |
| `lang` | string | `en` or `sw` (for decoys) |

Response `200 application/json`:

```json
{
  "words_ok": true,
  "words_found": [true, true, true],
  "chain_ok": true,
  "prior_found": [[true, true, true]],
  "decoys_flagged": [],
  "headcount": 7,
  "is_recapture": false,
  "recapture_score": 0.12,
  "reuse": {"is_reuse": false, "distance": 118, "match_id": null, "exact_duplicate": false},
  "reasons": ["All 3 words found", "7 people", "Not a photo of a screen", "New photo"],
  "engine": "claude",
  "ms": 3140
}
```

`GET /health` → `{"ok": true, "engine": "claude" | "openai" | "gemini" | "ollama" | "mock", "engines": [...]}`.
Config via env. Engines and what enables them: `claude` (`ANTHROPIC_API_KEY`), `openai`
(`OPENAI_API_KEY`), `gemini` (`GEMINI_API_KEY` or `GOOGLE_API_KEY`), `ollama` (`CHALK_OLLAMA_MODEL`,
a local model served by Ollama). Every enabled engine is tried in that order until one answers;
`CHALK_VISION_PROVIDER` moves one to the front. Models: `CHALK_VLM_MODEL` (default `claude-opus-5`),
`CHALK_OPENAI_MODEL` (`gpt-5.5`), `CHALK_GEMINI_MODEL` (`gemini-3.8-flash`). Also
`CHALK_VISION_MODE` (`auto` | `mock` | an engine name) and `CHALK_REUSE_THRESHOLD` (PDQ Hamming,
default 31). `GET /health` returns `engines`, the order the service will try, and `engine` in
`/verify` responses is the engine that answered, `mock`, or `mock-fallback`.

---

## 4. Backend (P1) — `backend/`

HTTP (JSON unless noted), default port 8787, CORS open for the app origin.

| Route | Body | Returns |
|---|---|---|
| `GET /health` | – | `{ok, cluster, rpcUrl, programId, usdcMint, relayer, oracle}` |
| `GET /config` | – | decoded Config + `slotMs` (measured) |
| `GET /slot` | – | `{slot, hash, currentSlot}` newest SlotHashes entry at `confirmed` (hash as hex); the app uses this instead of its own RPC |
| `GET /blockhash` | – | `{blockhash, lastValidBlockHeight}` for the app to build transactions |
| `GET /teacher/:wallet` | – | decoded Teacher or 404 |
| `GET /day/:wallet/:day` | – | decoded Day (with words resolved in `?lang=`) or 404 |
| `POST /relay` | `{tx: base64}` | `{signature, slot}` — co-signs as fee payer and sends; refuses any instruction not for this program, the Compute Budget program, or ATA create |
| `POST /verify` | multipart `teacher, day, idx, lang, image` | vision result + `{flags, attestSignature}` |
| `POST /recheck` | `{teacher, day}` | `{signature}` (trigger_recheck) |
| `POST /roll` | `{teacher, day}` | cranks roll_recheck at the latest boundary → `{signature, hit}` |
| `POST /settle` | `{teacher, day}` | `{signature, amount}` |
| `POST /watch` | `{teacher, day}` | `{watching}` — adds the day to the automatic re-check cranker (`CHALK_AUTO_ROLL=1`); days are also added when `/relay` lands a check-in |

POST routes are rate-limited per IP (`CHALK_RATE_LIMIT=0` disables); over the limit they return
`429 {error}` with `Retry-After`. `GET /health` also reports `autoRoll` and `rateLimit`.

Admin CLI: `pnpm --filter backend admin <cmd>` with `create-mint`, `init-config`,
`update-config`, `fund-vault <amount>`, `status`.

---

## 5. Shared deploy config — `shared/deploy.json`

Written by `scripts/setup-*.sh` and the admin CLI; read by backend and app.

```json
{
  "cluster": "localnet | devnet",
  "rpcUrl": "http://127.0.0.1:8899",
  "programId": "…",
  "usdcMint": "…",
  "relayer": "…",
  "oracle": "…"
}
```

Keypairs live in `keys/` (gitignored): `relayer.json`, `oracle.json`, `admin.json`.
