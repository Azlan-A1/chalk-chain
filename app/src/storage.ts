import { isLang, type Lang } from '@chalk/shared';

// Per-device conveniences in localStorage. Every access is guarded: storage can be missing or throw.

function read<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export interface Settings {
  lang: Lang | null;
  schoolId: number | null;
  /** wallet that finished register_teacher on this device */
  registered: string | null;
}

export function loadSettings(): Settings {
  const s = read<Partial<Settings>>('cc:settings', {});
  return {
    lang: isLang(s.lang) ? s.lang : null,
    schoolId: typeof s.schoolId === 'number' ? s.schoolId : null,
    registered: typeof s.registered === 'string' ? s.registered : null,
  };
}

export function saveSettings(s: Settings): void {
  write('cc:settings', s);
}

/** What the chain doesn't store: when each photo was sent and how old its words were. */
export interface LinkNote {
  at: number;
  slotAge?: number;
}

export function loadNotes(wallet: string, day: number): Record<number, LinkNote> {
  return read(`cc:notes:${wallet}:${day}`, {});
}

export function saveNote(wallet: string, day: number, idx: number, note: LinkNote): void {
  write(`cc:notes:${wallet}:${day}`, { ...loadNotes(wallet, day), [idx]: note });
}

export function clearAll(): void {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('cc:')) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}
