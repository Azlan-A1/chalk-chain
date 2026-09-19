// SPEC §2.5. Anchor custom error codes, in order from 6000.

export const ERROR_NAMES = [
  'SlotNotFound',
  'SlotTooOld',
  'SlotNotIncreasing',
  'SlotBeforeRecheck',
  'DayMismatch',
  'TooManyLinks',
  'NoRecheckPending',
  'RecheckExpired',
  'RecheckInProgress',
  'NotOracle',
  'AlreadySettled',
  'BadLinkIndex',
  'NotABoundary',
  'AlreadyRolled',
  'BadBoundary',
  'InvalidConfig',
] as const;

export type ChalkErrorName = (typeof ERROR_NAMES)[number];

export const ERROR_CODE_OFFSET = 6000;

/** Name → code, e.g. ERROR_CODES.SlotTooOld === 6001. */
export const ERROR_CODES = Object.fromEntries(ERROR_NAMES.map((n, i) => [n, ERROR_CODE_OFFSET + i])) as Record<
  ChalkErrorName,
  number
>;

export const ERROR_MESSAGES: Readonly<Record<ChalkErrorName, string>> = {
  SlotNotFound: 'Those words expired. Get new ones.',
  SlotTooOld: 'Photo sent too late. Get new words and try again.',
  SlotNotIncreasing: 'These words are older than your last photo.',
  SlotBeforeRecheck: 'Use the new words from this re-check.',
  DayMismatch: "Your phone's date looks wrong.",
  TooManyLinks: "Today's chain is full.",
  NoRecheckPending: 'No re-check is open right now.',
  RecheckExpired: 'The re-check window closed.',
  RecheckInProgress: 'A re-check is still open.',
  NotOracle: 'Only the verifier can do that.',
  AlreadySettled: 'Today is already settled.',
  BadLinkIndex: "That photo doesn't exist.",
  NotABoundary: 'Not a re-check boundary slot.',
  AlreadyRolled: 'That boundary was already rolled.',
  BadBoundary: 'Boundary slot out of range.',
  InvalidConfig: 'Invalid configuration.',
};

export interface ChalkError {
  code: number;
  name: ChalkErrorName;
  message: string;
}

export function chalkErrorFromCode(code: number): ChalkError | null {
  const name = ERROR_NAMES[code - ERROR_CODE_OFFSET];
  return name ? { code, name, message: ERROR_MESSAGES[name] } : null;
}

const CUSTOM_HEX = /custom program error: 0x([0-9a-fA-F]+)/;
const ANCHOR_NUMBER = /Error Number: (\d+)/;

function codeFromLogs(logs: readonly unknown[]): number | null {
  // Anchor's own log line is the most specific; fall back to the runtime's hex line.
  for (const l of logs) {
    const m = typeof l === 'string' ? ANCHOR_NUMBER.exec(l) : null;
    if (m) return Number(m[1]);
  }
  for (const l of logs) {
    const m = typeof l === 'string' ? CUSTOM_HEX.exec(l) : null;
    if (m) return parseInt(m[1]!, 16);
  }
  return null;
}

function asNumber(x: unknown): number | null {
  if (typeof x === 'number' && Number.isInteger(x)) return x;
  if (typeof x === 'bigint') return Number(x);
  return null;
}

/**
 * Pulls a custom program error code out of anything a failed send/simulate can produce:
 * a Kit SolanaError (walks `.cause` and `.context`), a raw `{ InstructionError: [i, { Custom: n }] }`,
 * a simulation result `{ err, logs }`, an array of log lines, or a message string.
 */
export function extractCustomErrorCode(err: unknown, depth = 0): number | null {
  if (err == null || depth > 8) return null;
  if (typeof err === 'string') {
    const kit = /Custom program error: #(\d+)/.exec(err);
    return codeFromLogs([err]) ?? (kit ? Number(kit[1]) : null);
  }
  if (Array.isArray(err)) {
    const fromLogs = codeFromLogs(err);
    if (fromLogs !== null) return fromLogs;
    for (const e of err) {
      const c = extractCustomErrorCode(e, depth + 1);
      if (c !== null) return c;
    }
    return null;
  }
  if (typeof err !== 'object') return null;
  const o = err as Record<string, unknown>;

  const custom = asNumber(o.Custom);
  if (custom !== null) return custom;

  if (Array.isArray(o.InstructionError)) {
    const c = extractCustomErrorCode(o.InstructionError[1], depth + 1);
    if (c !== null) return c;
  }

  const ctx = o.context as Record<string, unknown> | undefined;
  if (ctx && typeof ctx === 'object') {
    // SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM carries { code, index }.
    if ('index' in ctx) {
      const c = asNumber(ctx.code);
      if (c !== null) return c;
    }
    if (Array.isArray(ctx.logs)) {
      const c = codeFromLogs(ctx.logs);
      if (c !== null) return c;
    }
  }

  for (const key of ['cause', 'err', 'error', 'value', 'data'] as const) {
    if (key in o) {
      const c = extractCustomErrorCode(o[key], depth + 1);
      if (c !== null) return c;
    }
  }
  if (Array.isArray(o.logs)) {
    const c = codeFromLogs(o.logs);
    if (c !== null) return c;
  }
  if (typeof o.message === 'string') return extractCustomErrorCode(o.message, depth + 1);
  return null;
}

/** The Chalk Chain error behind a failure, or null if it is not one of ours. */
export function extractChalkError(err: unknown): ChalkError | null {
  const code = extractCustomErrorCode(err);
  return code === null ? null : chalkErrorFromCode(code);
}

/** Text to show the teacher for any failure. */
export function friendlyErrorMessage(err: unknown, fallback = 'Something went wrong. Try again.'): string {
  return extractChalkError(err)?.message ?? fallback;
}
