import { flagsToChecks, projectedPayout, wordsFor, type DayAccount, type Lang, type Link } from '@chalk/shared';
import { useState } from 'react';
import { api } from './api.ts';
import type { Ctx } from './flow.ts';
import { formatUsdc, nextLink, num, sealedSeconds } from './logic.ts';
import { loadNotes, type LinkNote } from './storage.ts';
import { ErrorBox, errorText, Spinner } from './ui.tsx';

interface Props {
  ctx: Ctx;
  day: DayAccount | null;
  dayLoaded: boolean;
  schoolId: number | null;
  onStart: () => void;
  onRefresh: () => void;
  onLang: (lang: Lang) => void;
  onReset: () => void;
}

export function Home({ ctx, day, dayLoaded, schoolId, onStart, onRefresh, onLang, onReset }: Props) {
  const next = nextLink(day, ctx.config?.maxLinks);
  const notes = loadNotes(ctx.wallet, ctx.dayNum);
  const today = new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <main className="screen">
      <header className="home-head">
        <h1 className="brand">Chalk Chain</h1>
        <p className="muted">
          {today}
          {schoolId !== null && ` · School ${schoolId}`}
        </p>
      </header>

      {!ctx.config && <ErrorBox message="The server isn't set up yet (no program config). Ask the organiser." />}

      {!dayLoaded ? (
        <Spinner label="Loading today…" />
      ) : (
        <>
          {day?.settled ? (
            <div className="paid-card">
              <span className="muted">Today is done</span>
              <strong>{formatUsdc(day.paid)} USDC</strong>
              <span className="muted">bonus paid</span>
            </div>
          ) : next ? (
            <button className={`btn btn-primary btn-xl${next.kind === 'recheck_in' ? ' btn-alert' : ''}`} onClick={onStart}>
              {next.kind === 'check_in' ? 'Start check-in' : 'Answer re-check'}
            </button>
          ) : (
            <p className="note">Checked in. Keep the words on the board — a re-check can come at any time.</p>
          )}

          <Timeline day={day} notes={notes} lang={ctx.lang} slotMs={ctx.slotMs} />

          {day && !day.settled && (
            <>
              {ctx.config && (
                <p className="muted center">
                  So far: {formatUsdc(projectedPayout(day, ctx.config.bonusPerLink).amount)} USDC if the day ended now
                </p>
              )}
              <EndDay ctx={ctx} onSettled={onRefresh} />
            </>
          )}
        </>
      )}

      <Demo ctx={ctx} onLang={onLang} onReset={onReset} onChanged={onRefresh} />
    </main>
  );
}

function Timeline({ day, notes, lang, slotMs }: { day: DayAccount | null; notes: Record<number, LinkNote>; lang: Lang; slotMs: number }) {
  if (!day || day.links.length === 0) {
    return <p className="empty">No photos yet today.</p>;
  }
  return (
    <ol className="timeline" aria-label="Today's chain">
      {day.links.map((l, i) => (
        <LinkItem key={i} idx={i} link={l} note={notes[i]} lang={lang} slotMs={slotMs} />
      ))}
    </ol>
  );
}

function LinkItem({ idx, link, note, lang, slotMs }: { idx: number; link: Link; note?: LinkNote; lang: Lang; slotMs: number }) {
  const c = flagsToChecks(link.flags);
  const time = note ? new Date(note.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : `Slot ${link.slot}`;
  const chips: [string, boolean][] = [
    ['Words', c.wordsOk],
    ...(idx > 0 ? ([['Earlier words', c.chainOk]] as [string, boolean][]) : []),
    [`People (${link.headcount})`, c.peopleOk],
    ['Real photo', c.notRecapture],
    ['New photo', c.notReused],
  ];
  return (
    <li className={`tl-item ${c.attested ? (link.passes ? 'pass' : 'fail') : 'pending'}`}>
      <div className="tl-dot" aria-hidden />
      <div className="tl-body">
        <div className="tl-head">
          <span className="tl-time">{time}</span>
          <span className="muted">{idx === 0 ? 'Check-in' : `Re-check ${idx}`}</span>
          {note?.slotAge !== undefined && <span className="muted">sealed in {sealedSeconds(num(note.slotAge), slotMs)} s</span>}
        </div>
        <div className="tl-words">{wordsFor(link.words, lang).join(' · ')}</div>
        {c.attested ? (
          <ul className="chips">
            {chips.map(([label, ok]) => (
              <li key={label} className={ok ? 'ok' : 'bad'}>
                {ok ? '✓' : '✗'} {label}
              </li>
            ))}
          </ul>
        ) : (
          <span className="muted">Not checked yet</span>
        )}
      </div>
    </li>
  );
}

function EndDay({ ctx, onSettled }: { ctx: Ctx; onSettled: () => void }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState<string | null>(null);

  async function settle() {
    if (!armed) return setArmed(true);
    setBusy(true);
    setError(null);
    try {
      const r = await api.settle(ctx.wallet, ctx.dayNum);
      setAmount(formatUsdc(r.amount));
      onSettled();
    } catch (e) {
      setError(errorText(e));
      setArmed(false);
    } finally {
      setBusy(false);
    }
  }

  if (amount !== null) {
    return (
      <div className="paid-card">
        <span className="muted">You earned</span>
        <strong>{amount} USDC</strong>
      </div>
    );
  }
  return (
    <div className="stack">
      {error && <ErrorBox message={error} />}
      {busy ? (
        <Spinner label="Ending the day…" />
      ) : (
        <button className={`btn ${armed ? 'btn-danger' : 'btn-secondary'}`} onClick={() => void settle()}>
          {armed ? 'Tap again to end the day' : 'End school day'}
        </button>
      )}
    </div>
  );
}

function Demo({ ctx, onLang, onReset, onChanged }: { ctx: Ctx; onLang: (l: Lang) => void; onReset: () => void; onChanged: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [slot, setSlot] = useState<number | null>(null);

  async function run(label: string, fn: () => Promise<string>) {
    setMsg(`${label}…`);
    try {
      setMsg(await fn());
      onChanged();
    } catch (e) {
      setMsg(errorText(e));
    }
  }

  return (
    <details className="demo" onToggle={(e) => (e.currentTarget.open ? void api.slot().then((s) => setSlot(num(s.currentSlot))).catch(() => {}) : null)}>
      <summary>Demo panel</summary>
      <dl className="kv">
        <dt>Program</dt>
        <dd>{ctx.programId}</dd>
        <dt>Relayer</dt>
        <dd>{ctx.relayer}</dd>
        <dt>Teacher</dt>
        <dd>{ctx.wallet}</dd>
        <dt>Day</dt>
        <dd>{ctx.dayNum}</dd>
        <dt>Slot</dt>
        <dd>
          {slot ?? '…'}{' '}
          <button className="btn-link" onClick={() => void api.slot().then((s) => setSlot(num(s.currentSlot)))}>
            refresh
          </button>
        </dd>
      </dl>
      <div className="demo-row">
        <button className="btn btn-small" onClick={() => onLang(ctx.lang === 'en' ? 'sw' : 'en')}>
          Words: {ctx.lang === 'en' ? 'English → Kiswahili' : 'Kiswahili → English'}
        </button>
        <button
          className="btn btn-small"
          onClick={() => void run('Starting re-check', async () => (await api.recheck(ctx.wallet, ctx.dayNum), 'Re-check started.'))}
        >
          Trigger re-check
        </button>
        <button
          className="btn btn-small"
          onClick={() =>
            void run('Rolling', async () => ((await api.roll(ctx.wallet, ctx.dayNum)).hit ? 'Roll hit: re-check started.' : 'Roll missed: no re-check.'))
          }
        >
          Roll for re-check
        </button>
        <button className="btn btn-small btn-danger" onClick={onReset}>
          Reset teacher
        </button>
      </div>
      {msg && <p className="demo-msg">{msg}</p>}
    </details>
  );
}
