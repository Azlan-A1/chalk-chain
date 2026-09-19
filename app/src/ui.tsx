import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { CheckRow } from './logic.ts';
import { formatCountdown } from './logic.ts';

export function useNow(intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** The chalkboard: earlier words small at the top, the new words huge. */
export function Board({ words, prior = [], faded }: { words: string[]; prior?: string[][]; faded?: boolean }) {
  return (
    <div className={`board${faded ? ' faded' : ''}`}>
      {prior.map((p, i) => (
        <div key={i} className="board-prior">
          {p.join('  ·  ')}
        </div>
      ))}
      {prior.length > 0 && <div className="board-rule" aria-hidden />}
      {words.map((w, i) => (
        <div key={i} className="board-word">
          {w}
        </div>
      ))}
    </div>
  );
}

export function Ring({ msLeft, totalMs, size = 112 }: { msLeft: number; totalMs: number; size?: number }) {
  const r = size / 2 - 8;
  const c = 2 * Math.PI * r;
  const frac = totalMs > 0 ? Math.max(0, Math.min(1, msLeft / totalMs)) : 0;
  const tone = frac > 0.35 ? 'ok' : frac > 0.15 ? 'warn' : 'late';
  return (
    <div className={`ring ring-${tone}`} role="timer" aria-label={`${Math.ceil(msLeft / 1000)} seconds left`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle className="ring-track" cx={size / 2} cy={size / 2} r={r} />
        <circle
          className="ring-bar"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - frac)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="ring-text">{formatCountdown(msLeft)}</span>
    </div>
  );
}

export function CheckList({ rows, animate = true }: { rows: CheckRow[]; animate?: boolean }) {
  return (
    <ul className="checks">
      {rows.map((r, i) => (
        <li
          key={r.key}
          className={`check ${r.ok ? 'pass' : 'fail'}${animate ? ' reveal' : ''}`}
          style={animate ? { animationDelay: `${i * 450}ms` } : undefined}
        >
          <span className="check-mark" aria-hidden>
            {r.ok ? '✓' : '✗'}
          </span>
          <span className="check-label">{r.label}</span>
          {r.detail && <span className="check-detail">{r.detail}</span>}
          <span className="sr-only">{r.ok ? 'passed' : 'failed'}</span>
        </li>
      ))}
    </ul>
  );
}

export function ErrorBox({ message, children }: { message: string; children?: ReactNode }) {
  return (
    <div className="error" role="alert">
      <p>{message}</p>
      {children}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="spinner-row" role="status">
      <span className="spinner" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong. Try again.';
}

export function useToast(ms = 2600): [string | null, (message: string) => void] {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = useCallback(
    (m: string) => {
      clearTimeout(timer.current);
      setMessage(m);
      timer.current = setTimeout(() => setMessage(null), ms);
    },
    [ms],
  );
  useEffect(() => () => clearTimeout(timer.current), []);
  return [message, show];
}

export function Toast({ message }: { message: string | null }) {
  return (
    <div className="toast-slot" role="status" aria-live="polite">
      {message && <div className="toast">{message}</div>}
    </div>
  );
}
