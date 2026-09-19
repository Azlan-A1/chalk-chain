import { dayFromJson, dayNumber, type DayAccount, type Lang } from '@chalk/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.ts';
import { CheckIn } from './CheckIn.tsx';
import { loadBackend, type Ctx } from './flow.ts';
import { Home } from './Home.tsx';
import { forgetTeacher, loadTeacherSigner } from './key.ts';
import { num, slotsMsLeft, formatCountdown } from './logic.ts';
import { Setup } from './Setup.tsx';
import { clearAll, loadSettings, saveSettings, type Settings } from './storage.ts';
import { ErrorBox, errorText, Spinner, useNow } from './ui.tsx';

type Base = Omit<Ctx, 'lang' | 'dayNum'>;

const POLL_MS = 4000;

export function App() {
  const [base, setBase] = useState<Base | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [screen, setScreen] = useState<'home' | 'checkin'>('home');
  const [day, setDay] = useState<DayAccount | null>(null);
  const [dayLoaded, setDayLoaded] = useState(false);
  const [slotAt, setSlotAt] = useState<{ slot: number; at: number } | null>(null);
  const [dismissedRecheck, setDismissedRecheck] = useState<string | null>(null);

  const boot = useCallback(async () => {
    setBootError(null);
    try {
      const [signer, backend] = await Promise.all([loadTeacherSigner(), loadBackend()]);
      // The local "registered" flag outlives a chain reset (new localnet, devnet): trust the chain.
      const onChain = await api.teacher(signer.address).catch(() => undefined);
      if (onChain !== undefined) {
        setSettings((s) => {
          const want = onChain ? signer.address : null;
          if (s.registered === want) return s;
          const next = { ...s, registered: want, schoolId: onChain?.schoolId ?? s.schoolId };
          saveSettings(next);
          return next;
        });
      }
      setBase({ signer, wallet: signer.address, ...backend });
    } catch (e) {
      setBootError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void boot();
  }, [boot]);

  const update = (s: Settings) => {
    setSettings(s);
    saveSettings(s);
  };

  const registered = base !== null && settings.registered === base.wallet && settings.lang !== null;
  const dayNum = dayNumber();
  // Stable identity: screens key effects off ctx, and the 4 s poll re-renders App.
  const ctx = useMemo<Ctx | null>(
    () => (base && settings.lang ? { ...base, lang: settings.lang, dayNum } : null),
    [base, settings.lang, dayNum],
  );

  const refreshDay = useCallback(async () => {
    if (!ctx) return;
    try {
      const j = await api.day(ctx.wallet, ctx.dayNum, ctx.lang);
      const d = j ? dayFromJson(j) : null;
      setDay(d);
      setDayLoaded(true);
      if (d?.recheckPending) {
        const s = await api.slot();
        setSlotAt({ slot: num(s.currentSlot, num(s.slot)), at: Date.now() });
      }
    } catch {
      /* keep the last good state; the next poll retries */
    }
  }, [ctx]);

  const refreshRef = useRef(refreshDay);
  refreshRef.current = refreshDay;
  useEffect(() => {
    if (!registered) return;
    void refreshRef.current();
    const id = setInterval(() => void refreshRef.current(), POLL_MS);
    return () => clearInterval(id);
  }, [registered, settings.lang]);

  async function reset() {
    if (!confirm('Forget this teacher on this phone? A new teacher will be created.')) return;
    await forgetTeacher();
    clearAll();
    location.reload();
  }

  if (bootError) {
    return (
      <main className="screen">
        <h1 className="brand">Chalk Chain</h1>
        <ErrorBox message={bootError}>
          <button className="btn btn-primary" onClick={() => void boot()}>
            Try again
          </button>
        </ErrorBox>
      </main>
    );
  }
  if (!base) {
    return (
      <main className="screen">
        <h1 className="brand">Chalk Chain</h1>
        <Spinner label="Starting…" />
      </main>
    );
  }
  if (!registered || !ctx) {
    return (
      <Setup
        ctx={{ ...base, dayNum }}
        initialLang={settings.lang}
        onDone={(lang, schoolId) => update({ lang, schoolId, registered: base.wallet })}
      />
    );
  }

  const recheckKey = day?.recheckPending ? `${day.day}:${day.recheckDeadlineSlot}` : null;
  const showAlert = recheckKey !== null && recheckKey !== dismissedRecheck && screen === 'home';

  return (
    <>
      {screen === 'checkin' ? (
        <CheckIn
          ctx={ctx}
          onDone={() => {
            setScreen('home');
            void refreshDay();
          }}
        />
      ) : (
        <Home
          ctx={ctx}
          day={day}
          dayLoaded={dayLoaded}
          schoolId={settings.schoolId}
          onStart={() => setScreen('checkin')}
          onRefresh={() => void refreshDay()}
          onLang={(lang: Lang) => update({ ...settings, lang })}
          onReset={() => void reset()}
        />
      )}
      {showAlert && day && (
        <RecheckAlert
          deadlineSlot={Number(day.recheckDeadlineSlot)}
          slotAt={slotAt}
          slotMs={ctx.slotMs}
          onGo={() => {
            setDismissedRecheck(recheckKey);
            setScreen('checkin');
          }}
          onLater={() => setDismissedRecheck(recheckKey)}
        />
      )}
    </>
  );
}

function RecheckAlert(p: {
  deadlineSlot: number;
  slotAt: { slot: number; at: number } | null;
  slotMs: number;
  onGo: () => void;
  onLater: () => void;
}) {
  const now = useNow(500);
  useEffect(() => {
    try {
      navigator.vibrate?.([400, 200, 400, 200, 400]);
    } catch {
      /* not supported */
    }
  }, []);
  const left = p.slotAt ? slotsMsLeft(p.deadlineSlot, p.slotAt.slot, p.slotMs, now - p.slotAt.at) : null;
  return (
    <div className="alert-overlay" role="alertdialog" aria-modal="true" aria-labelledby="recheck-title">
      <div className="alert-body">
        <h2 id="recheck-title">Re-check!</h2>
        <p>Add 3 new words under the others.</p>
        {left !== null && <div className="alert-countdown">{formatCountdown(left)}</div>}
        <button className="btn btn-primary btn-xl" onClick={p.onGo}>
          Get the words
        </button>
        <button className="btn-link light" onClick={p.onLater}>
          Later
        </button>
      </div>
    </div>
  );
}
