import { dayFromJson, flagsToChecks, projectedPayout, wordsFor, type DayAccount, type Lang, type Link } from '@chalk/shared';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from './api.ts';
import type { Ctx } from './flow.ts';
import { checksPass, dayDate, formatUsdc, linkChips, nextLink, num, photoActions, proofHash, recheckMissed, sealedSeconds } from './logic.ts';
import { deletePhoto, listPhotos, loadPhoto, photoBlob } from './photos.ts';
import { loadNotes, type LinkNote } from './storage.ts';
import { ErrorBox, errorText, Spinner, Toast, useToast } from './ui.tsx';

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
  const next = nextLink(day, ctx.config?.maxLinks, ctx.currentSlot);
  const missed = recheckMissed(day, ctx.currentSlot);
  const notes = loadNotes(ctx.wallet, ctx.dayNum);
  // Label the school day the chain is using (UTC day number), not the phone's local date:
  // they differ for a few hours each evening and it looked like the day had been lost.
  const today = new Date((day?.day ?? ctx.dayNum) * 86_400_000).toLocaleDateString([], {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
  });
  const [pending, recheckPending] = usePendingPhotos(ctx, day, dayLoaded);
  const [toast, showToast] = useToast();
  const onChecked = (message: string) => {
    showToast(message);
    recheckPending();
    onRefresh();
  };
  const checkAgain = (d: number, idx: number) => <CheckAgain ctx={ctx} day={d} idx={idx} onChecked={onChecked} />;
  const earlier = pending.filter((p) => p.day !== ctx.dayNum);

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
          ) : missed ? (
            <p className="note">
              A re-check went unanswered, so today pays nothing. Ending the day will record that.
            </p>
          ) : (
            <p className="note">Checked in. Keep the words on the board — a re-check can come at any time.</p>
          )}

          {earlier.map((p) => (
            <div key={`${p.day}:${p.idx}`} className="note pending-note">
              <span>
                A photo from {dayDate(p.day, { weekday: 'long', day: 'numeric', month: 'long' })} was recorded but not checked yet.
              </span>
              {checkAgain(p.day, p.idx)}
            </div>
          ))}

          <Timeline
            day={day}
            notes={notes}
            lang={ctx.lang}
            slotMs={ctx.slotMs}
            action={(idx) => (pending.some((p) => p.day === ctx.dayNum && p.idx === idx) ? checkAgain(ctx.dayNum, idx) : null)}
          />

          {day && day.links.length > 0 && <ShareProof ctx={ctx} onToast={showToast} />}

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
      <Toast message={toast} />
    </main>
  );
}

interface PendingPhoto {
  day: number;
  idx: number;
}

/**
 * Links on this phone that are on-chain but not checked yet (the stored photo is still here).
 * Photos for links that are already attested, or on settled days, are deleted as a side effect.
 */
function usePendingPhotos(ctx: Ctx, day: DayAccount | null, dayLoaded: boolean): [PendingPhoto[], () => void] {
  const [pending, setPending] = useState<PendingPhoto[]>([]);
  const [tick, setTick] = useState(0);
  const sig = day ? `${day.settled}:${day.links.map((l) => l.flags).join(',')}` : 'none';
  useEffect(() => {
    if (!dayLoaded) return;
    let live = true;
    void (async () => {
      const byDay = new Map<number, number[]>();
      for (const p of await listPhotos(ctx.wallet)) byDay.set(p.day, [...(byDay.get(p.day) ?? []), p.idx]);
      const out: PendingPhoto[] = [];
      for (const [d, idxs] of byDay) {
        const acc =
          d === ctx.dayNum
            ? day
            : await api.day(ctx.wallet, d, ctx.lang).then((j) => (j ? dayFromJson(j) : null), () => null);
        const { retry, drop } = photoActions(acc, idxs);
        for (const i of drop) await deletePhoto(ctx.wallet, d, i).catch(() => {});
        out.push(...retry.map((idx) => ({ day: d, idx })));
      }
      if (live) setPending(out.sort((a, b) => a.day - b.day || a.idx - b.idx));
    })().catch(() => {});
    return () => {
      live = false;
    };
    // `sig` stands in for `day`: the poll hands us a new object every 4 s.
  }, [ctx, sig, dayLoaded, tick]);
  return [pending, useCallback(() => setTick((t) => t + 1), [])];
}

function CheckAgain({ ctx, day, idx, onChecked }: { ctx: Ctx; day: number; idx: number; onChecked: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const photo = await loadPhoto(ctx.wallet, day, idx);
      if (!photo) throw new Error('This photo is no longer on this phone.');
      const r = await api.verify({ teacher: ctx.wallet, day, idx, lang: ctx.lang, image: photoBlob(photo) });
      await deletePhoto(ctx.wallet, day, idx).catch(() => {});
      onChecked(checksPass(r.flags) ? 'Photo checked: all checks passed' : 'Photo checked: some checks failed');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="check-again">
      {busy ? (
        <Spinner label="Checking the photo…" />
      ) : (
        <button className="btn btn-primary btn-small-primary" onClick={() => void run()}>
          Check again
        </button>
      )}
      {error && <p className="check-again-error">{error}</p>}
    </div>
  );
}

function ShareProof({ ctx, onToast }: { ctx: Ctx; onToast: (message: string) => void }) {
  const hash = proofHash(ctx.wallet, ctx.dayNum, ctx.lang);
  const url = `${location.origin}${location.pathname}${hash}`;

  async function share() {
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: 'Chalk Chain proof of class', text: "Today's class, proven on Solana.", url });
        return;
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      onToast('Link copied');
    } catch {
      window.prompt('Copy this link', url);
    }
  }

  return (
    <div className="share-row">
      <button className="btn btn-secondary" onClick={() => void share()}>
        Share today's proof
      </button>
      <a className="btn-link" href={hash}>
        Open proof page
      </a>
    </div>
  );
}

function Timeline({
  day,
  notes,
  lang,
  slotMs,
  action,
}: {
  day: DayAccount | null;
  notes: Record<number, LinkNote>;
  lang: Lang;
  slotMs: number;
  action: (idx: number) => ReactNode;
}) {
  if (!day || day.links.length === 0) {
    return <p className="empty">No photos yet today.</p>;
  }
  return (
    <ol className="timeline" aria-label="Today's chain">
      {day.links.map((l, i) => (
        <LinkItem key={i} idx={i} link={l} note={notes[i]} lang={lang} slotMs={slotMs} action={action(i)} />
      ))}
    </ol>
  );
}

export function LinkItem({
  idx,
  link,
  note,
  lang,
  slotMs = 400,
  action,
}: {
  idx: number;
  link: Link;
  note?: LinkNote;
  lang: Lang;
  slotMs?: number;
  action?: ReactNode;
}) {
  const c = flagsToChecks(link.flags);
  const time = note ? new Date(note.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : `Slot ${link.slot}`;
  const chips = linkChips(link.flags, link.headcount, idx);
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
        {!c.attested && action}
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
