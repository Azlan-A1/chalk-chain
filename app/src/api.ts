import { chalkErrorFromCode, type ConfigJson, type DayJson, type Lang, type TeacherJson } from '@chalk/shared';

// Backend routes, SPEC §4. The app never talks to an RPC node directly.

export const BACKEND_URL: string = (
  import.meta.env.VITE_BACKEND_URL || (import.meta.env.DEV ? '/api' : 'http://localhost:8787')
).replace(/\/$/, '');

export interface Health {
  ok: boolean;
  cluster: string;
  rpcUrl: string;
  /** Set when the chain is reachable from outside this laptop (demo tunnel). */
  publicRpcUrl?: string;
  programId: string;
  usdcMint: string;
  relayer: string;
  oracle: string;
}

export type ConfigWire = ConfigJson & { slotMs?: number };

/** Numbers may arrive as JSON numbers or decimal strings (u64); the app only needs Number precision for slots. */
type Num = number | string;

export interface SlotInfo {
  slot: Num;
  hash: string;
  currentSlot: Num;
}

export interface RelayResult {
  signature: string;
  slot?: Num;
  /** Optional extra: slots between challenge and landing, parsed from the CheckedIn event. */
  slotAge?: Num;
  slot_age?: Num;
}

export interface VisionResult {
  words_ok: boolean;
  words_found: boolean[];
  chain_ok: boolean;
  prior_found: boolean[][];
  decoys_flagged: string[];
  headcount: number;
  is_recapture: boolean;
  recapture_score: number;
  reuse: { is_reuse: boolean; distance: number | null; match_id: string | null; exact_duplicate: boolean };
  reasons: string[];
  engine: string;
  ms: number;
}

export type VerifyResult = VisionResult & { flags: number; attestSignature?: string | null };

/** An error the teacher can read: a chalk_chain program error when we can tell, else the backend's text. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: number | null;
  constructor(message: string, status: number, code: number | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BACKEND_URL + path, init);
  } catch {
    throw new ApiError("Can't reach the Chalk Chain server. Check your internet and try again.", 0);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text };
  }
  if (!res.ok) {
    const b = (body ?? {}) as { error?: unknown; code?: unknown };
    const code = typeof b.code === 'number' ? b.code : null;
    const friendly = code !== null ? chalkErrorFromCode(code)?.message : undefined;
    const msg = friendly ?? (typeof b.error === 'string' && b.error ? b.error : `Server error (${res.status})`);
    throw new ApiError(msg, res.status, code);
  }
  return body as T;
}

// Set by scripts/demo.sh so the demo panel can still drive re-checks and settle while the
// backend refuses those routes to everyone else.
const ADMIN_TOKEN = (import.meta.env?.VITE_ADMIN_TOKEN as string | undefined)?.trim();
export const authHeaders = (): Record<string, string> =>
  ADMIN_TOKEN ? { authorization: `Bearer ${ADMIN_TOKEN}` } : {};

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...authHeaders() },
  body: JSON.stringify(body),
});

async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

export const api = {
  health: () => call<Health>('/health'),
  config: () => call<ConfigWire>('/config'),
  slot: () => call<SlotInfo>('/slot'),
  blockhash: () => call<{ blockhash: string; lastValidBlockHeight: Num }>('/blockhash'),
  teacher: (wallet: string) => orNull(call<TeacherJson>(`/teacher/${wallet}`)),
  day: (wallet: string, day: number, lang: Lang) => orNull(call<DayJson>(`/day/${wallet}/${day}?lang=${lang}`)),
  relay: (tx: string) => call<RelayResult>('/relay', json({ tx })),
  verify: (f: { teacher: string; day: number; idx: number; lang: Lang; image: Blob }) => {
    const form = new FormData();
    form.set('teacher', f.teacher);
    form.set('day', String(f.day));
    form.set('idx', String(f.idx));
    form.set('lang', f.lang);
    form.set('image', f.image, 'photo.jpg');
    return call<VerifyResult>('/verify', { method: 'POST', body: form });
  },
  recheck: (teacher: string, day: number) => call<{ signature: string }>('/recheck', json({ teacher, day })),
  roll: (teacher: string, day: number) => call<{ signature: string; hit: boolean }>('/roll', json({ teacher, day })),
  settle: (teacher: string, day: number) => call<{ signature: string; amount: Num }>('/settle', json({ teacher, day })),
};
