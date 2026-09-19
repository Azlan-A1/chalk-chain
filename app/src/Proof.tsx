import {
  dayFromJson,
  dayNumber,
  findDayPda,
  flagsToChecks,
  teacherFromJson,
  wordsFor,
  type DayAccount,
  type Lang,
  type TeacherAccount,
} from '@chalk/shared';
import { address, type Address } from '@solana/kit';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Health } from './api.ts';
import { LinkItem } from './Home.tsx';
import { dayDate, explorerAddressUrl, formatUsdc2, proofHash } from './logic.ts';
import { loadSettings } from './storage.ts';
import { ErrorBox, errorText, Spinner } from './ui.tsx';

// Public, read-only proof of one teacher's day: GET /health, /teacher/:wallet and /day/:wallet/:day only.

const POLL_MS = 5000;
const EARLIER = [1, 2, 3];

interface Loaded {
  health: Health;
  teacher: TeacherAccount | null;
  day: DayAccount | null;
  dayPda: Address;
  earlier: { day: number; acc: DayAccount }[];
}

const LANG_LABELS: Record<Lang, string> = { en: 'English', sw: 'Kiswahili' };

export function Proof({ wallet, day: dayParam, lang: langParam }: { wallet: Address; day: number | null; lang: Lang | null }) {
  const today = dayNumber();
  const day = dayParam ?? today;
  const [lang, setLang] = useState<Lang>(() => langParam ?? loadSettings().lang ?? 'en');
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const health = await api.health();
    const [teacher, main, [dayPda], earlier] = await Promise.all([
      api.teacher(wallet),
      api.day(wallet, day, lang),
      findDayPda(address(health.programId), wallet, day),
      Promise.all(EARLIER.map((k) => (day - k < 0 ? null : api.day(wallet, day - k, lang).catch(() => null)))),
    ]);
    return {
      health,
      teacher: teacher ? teacherFromJson(teacher) : null,
      day: main ? dayFromJson(main) : null,
      dayPda,
      earlier: earlier.flatMap((j, i) => (j ? [{ day: day - EARLIER[i]!, acc: dayFromJson(j) }] : [])),
    };
  }, [wallet, day, lang]);

  const refresh = useCallback(
    async (showErrors: boolean) => {
      try {
        setData(await load());
        setError(null);
      } catch (e) {
        if (showErrors) setError(errorText(e));
      }
    },
    [load],
  );

  const hasData = useRef(false);
  hasData.current = data !== null;
  useEffect(() => {
    void refresh(!hasData.current);
  }, [refresh]);

  // Today's page stays live until the day is settled, so it can sit on a projector during a check-in.
  const live = day === today && !data?.day?.settled && data?.teacher != null;
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => void refresh(false), POLL_MS);
    return () => clearInterval(id);
  }, [live, refresh]);

  useEffect(() => {
    const school = data?.teacher ? `School ${data.teacher.schoolId} · ` : '';
    document.title = `${school}${dayDate(day, { day: 'numeric', month: 'short', year: 'numeric' })} · Chalk Chain proof`;
    return () => {
      document.title = 'Chalk Chain';
    };
  }, [data?.teacher, day]);

  return (
    <main className="proof">
      <header className="pf-top">
        <div className="pf-brand-row">
          <span className="brand pf-brand">Chalk Chain</span>
          <span className="pf-kicker">Proof of class</span>
          {live && <span className="pf-live">Live</span>}
        </div>
        <div className="pf-lang" role="group" aria-label="Words language">
          {(Object.keys(LANG_LABELS) as Lang[]).map((l) => (
            <button key={l} className={`pf-lang-btn${lang === l ? ' selected' : ''}`} aria-pressed={lang === l} onClick={() => setLang(l)}>
              {LANG_LABELS[l]}
            </button>
          ))}
        </div>
      </header>

      {error ? (
        <ErrorBox message={error}>
          <button className="btn btn-primary" onClick={() => void refresh(true)}>
            Try again
          </button>
        </ErrorBox>
      ) : !data ? (
        <Spinner label="Reading the chain…" />
      ) : (
        <ProofBody data={data} wallet={wallet} day={day} isToday={day === today} lang={lang} />
      )}
    </main>
  );
}

function ProofBody({ data, wallet, day, isToday, lang }: { data: Loaded; wallet: Address; day: number; isToday: boolean; lang: Lang }) {
  const { teacher, day: d } = data;
  return (
    <>
      <section className="pf-title">
        <h1>{teacher ? `School ${teacher.schoolId}` : 'Unknown teacher'}</h1>
        <p className="pf-date">
          {dayDate(day)}
          {isToday && <span className="pf-today">Today</span>}
        </p>
        {!teacher && <p className="muted">This wallet is not a registered Chalk Chain teacher.</p>}
      </section>

      <section className="pf-hero">
        <ChainBoard day={d} lang={lang} />
        <div className="pf-side">
          <Stats day={d} />
          {d ? (
            <div className="pf-explorer">
              <a className="btn btn-secondary pf-explorer-btn" href={explorerAddressUrl(data.dayPda, data.health)} target="_blank" rel="noreferrer">
                View on Solana Explorer ↗
              </a>
              <p className="pf-mono">
                <span className="muted">Day account</span> {data.dayPda}
              </p>
            </div>
          ) : (
            <p className="muted">No Day account on-chain for this date.</p>
          )}
        </div>
      </section>

      <div className="pf-columns">
        <section>
          <h2 className="pf-h2">The chain</h2>
          {d && d.links.length > 0 ? (
            <ol className="timeline pf-timeline" aria-label="The chain">
              {d.links.map((l, i) => (
                <LinkItem key={i} idx={i} link={l} lang={lang} />
              ))}
            </ol>
          ) : (
            <p className="empty">No photos on this day.</p>
          )}
        </section>

        <section>
          <h2 className="pf-h2">Earlier days</h2>
          {data.earlier.length > 0 ? (
            <div className="pf-days">
              {data.earlier.map((e) => (
                <DayCard key={e.day} wallet={wallet} day={e.day} acc={e.acc} lang={lang} />
              ))}
            </div>
          ) : (
            <p className="empty">No check-ins in the 3 days before.</p>
          )}
          {teacher && (
            <p className="muted pf-total">
              All time: {formatUsdc2(teacher.totalPaid)} USDC over {teacher.daysSettled} settled {teacher.daysSettled === 1 ? 'day' : 'days'}
            </p>
          )}
        </section>
      </div>

      <footer className="pf-foot">
        <p>
          Each set of words comes from a live Solana slot hash. The photo's hash had to land on-chain within about
          90 seconds of those words existing, and each re-check's words chain from the photo before it.
        </p>
        <p className="pf-mono">
          <span className="muted">Teacher</span> {wallet}
        </p>
        {day !== dayNumber() && (
          <a className="btn-link" href={proofHash(wallet, null, lang)}>
            Go to today
          </a>
        )}
      </footer>
    </>
  );
}

function ChainBoard({ day, lang }: { day: DayAccount | null; lang: Lang }) {
  if (!day || day.links.length === 0) {
    return (
      <div className="board pf-board">
        <div className="pf-board-empty">No check-in on this day</div>
      </div>
    );
  }
  return (
    <div className="board pf-board" aria-label="Words on the board">
      {day.links.map((l, i) => {
        const attested = flagsToChecks(l.flags).attested;
        const tone = !attested ? 'pending' : l.passes ? 'pass' : 'fail';
        return (
          <div key={i} className={`pf-line ${tone}`}>
            <span className="pf-line-label">{i === 0 ? 'Check-in' : `Re-check ${i}`}</span>
            <span className="pf-line-words">{wordsFor(l.words, lang).join('\u00a0· ')}</span>
            <span className="pf-line-mark" aria-label={tone === 'pass' ? 'passed' : tone === 'fail' ? 'failed' : 'not checked yet'}>
              {tone === 'pass' ? '✓' : tone === 'fail' ? '✗' : '…'}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Stats({ day }: { day: DayAccount | null }) {
  const links = day?.links ?? [];
  const passing = links.filter((l) => l.passes).length;
  const attested = links.filter((l) => flagsToChecks(l.flags).attested);
  const people = attested.length ? Math.max(...attested.map((l) => l.headcount)) : null;
  const rechecks: [string, string] = !day
    ? ['–', '']
    : day.missedRecheck
      ? ['Missed', 'bad']
      : day.recheckPending && !day.settled
        ? ['Open now', 'warn']
        : day.rechecksMet > 0
          ? [`${day.rechecksMet} answered`, 'ok']
          : ['None asked', ''];
  return (
    <dl className="pf-stats">
      <div className={`pf-stat pf-paid${day?.settled ? '' : ' unsettled'}`}>
        <dt>Bonus paid</dt>
        <dd>{!day ? 'No check-in' : day.settled ? `${formatUsdc2(day.paid)} USDC` : 'Not settled yet'}</dd>
      </div>
      <div className="pf-stat">
        <dt>Photos passed</dt>
        <dd>
          {passing} of {links.length}
        </dd>
      </div>
      <div className={`pf-stat ${rechecks[1]}`}>
        <dt>Re-checks</dt>
        <dd>{rechecks[0]}</dd>
      </div>
      <div className="pf-stat">
        <dt>Most people seen</dt>
        <dd>{people ?? '–'}</dd>
      </div>
    </dl>
  );
}

function DayCard({ wallet, day, acc, lang }: { wallet: Address; day: number; acc: DayAccount; lang: Lang }) {
  const passing = acc.links.filter((l) => l.passes).length;
  const first = acc.links[0];
  return (
    <a className="pf-day" href={proofHash(wallet, day, lang)}>
      <span className="pf-day-date">{dayDate(day, { weekday: 'short', day: 'numeric', month: 'short' })}</span>
      {first && <span className="pf-day-words">{wordsFor(first.words, lang).join('\u00a0· ')}</span>}
      <span className="muted">
        {passing} of {acc.links.length} passed{acc.missedRecheck ? ' · missed a re-check' : ''}
      </span>
      <strong>{acc.settled ? `${formatUsdc2(acc.paid)} USDC` : 'Not settled yet'}</strong>
    </a>
  );
}

export function BadProofLink() {
  return (
    <main className="proof">
      <header className="pf-top">
        <div className="pf-brand-row">
          <span className="brand pf-brand">Chalk Chain</span>
          <span className="pf-kicker">Proof of class</span>
        </div>
      </header>
      <ErrorBox message="This proof link isn't valid. Check that it was copied in full.">
        <a className="btn-link" href="#/">
          Open the Chalk Chain app
        </a>
      </ErrorBox>
    </main>
  );
}
