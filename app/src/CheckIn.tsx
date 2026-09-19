import { dayFromJson } from '@chalk/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type VerifyResult } from './api.ts';
import { sendLink, type Ctx } from './flow.ts';
import {
  checkRows,
  checksPass,
  num,
  sealedSeconds,
  slotsMsLeft,
  windowMsLeft,
  wordsForNext,
  type WordsForLink,
} from './logic.ts';
import { preparePhoto, type PreparedPhoto } from './photo.ts';
import { deletePhoto, savePhoto } from './photos.ts';
import { saveNote } from './storage.ts';
import { Board, CheckList, ErrorBox, errorText, Ring, Spinner, useNow } from './ui.tsx';

interface Challenge extends WordsForLink {
  slot: number;
  /** ms left when fetched, and when that was */
  leftMs: number;
  totalMs: number;
  at: number;
}

type Phase =
  | { t: 'loading' }
  | { t: 'words'; ch: Challenge }
  | { t: 'sending'; ch: Challenge; photo?: PreparedPhoto }
  | { t: 'checking'; ch: Challenge; photo: PreparedPhoto; sealedS: number; result?: VerifyResult; error?: string }
  | { t: 'error'; message: string; retryWords: boolean };

export function CheckIn({ ctx, onDone }: { ctx: Ctx; onDone: () => void }) {
  const [phase, setPhase] = useState<Phase>({ t: 'loading' });
  const fileRef = useRef<HTMLInputElement>(null);
  const now = useNow();

  const getWords = useCallback(async () => {
    setPhase({ t: 'loading' });
    try {
      const [s, dj] = await Promise.all([api.slot(), api.day(ctx.wallet, ctx.dayNum, ctx.lang)]);
      const day = dj ? dayFromJson(dj) : null;
      const w = wordsForNext(ctx.wallet, ctx.dayNum, day, s.hash, ctx.lang, ctx.config?.maxLinks);
      if (!w) {
        setPhase({ t: 'error', message: day?.settled ? 'Today is already settled.' : 'No re-check is open right now.', retryWords: false });
        return;
      }
      const slot = num(s.slot);
      const currentSlot = num(s.currentSlot, slot);
      const windowSlots = num(ctx.config?.windowSlots, 225);
      const totalMs = windowSlots * ctx.slotMs;
      let leftMs = windowMsLeft({ windowSlots, slot, currentSlot, slotMs: ctx.slotMs });
      if (w.kind === 'recheck_in' && day) {
        leftMs = Math.min(leftMs, slotsMsLeft(Number(day.recheckDeadlineSlot), currentSlot, ctx.slotMs));
      }
      setPhase({ t: 'words', ch: { ...w, slot, leftMs, totalMs, at: Date.now() } });
    } catch (e) {
      setPhase({ t: 'error', message: errorText(e), retryWords: true });
    }
  }, [ctx]);

  // Once per visit; later refreshes are explicit ("Get new words").
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void getWords();
  }, [getWords]);

  const verify = useCallback(
    async (ch: Challenge, photo: PreparedPhoto, sealedS: number) => {
      setPhase({ t: 'checking', ch, photo, sealedS });
      try {
        const result = await api.verify({ teacher: ctx.wallet, day: ctx.dayNum, idx: ch.idx, lang: ctx.lang, image: photo.blob });
        void deletePhoto(ctx.wallet, ctx.dayNum, ch.idx).catch(() => {});
        setPhase({ t: 'checking', ch, photo, sealedS, result });
      } catch (e) {
        setPhase({ t: 'checking', ch, photo, sealedS, error: errorText(e) });
      }
    },
    [ctx],
  );

  async function onFile(file: File | undefined, ch: Challenge) {
    if (!file) return;
    setPhase({ t: 'sending', ch });
    try {
      const photo = await preparePhoto(file);
      setPhase({ t: 'sending', ch, photo });
      const r = await sendLink(ctx, ch, ch.slot, photo.hash);
      const slotAge = r.slotAge ?? r.slot_age ?? (r.slot !== undefined ? num(r.slot) - ch.slot : undefined);
      const sealedS =
        slotAge !== undefined
          ? sealedSeconds(num(slotAge), ctx.slotMs)
          : Math.round((ch.totalMs - ch.leftMs + (Date.now() - ch.at)) / 1000);
      saveNote(ctx.wallet, ctx.dayNum, ch.idx, { at: Date.now(), slotAge: slotAge !== undefined ? num(slotAge) : undefined });
      // On-chain now: keep the exact bytes until /verify succeeds, so a failed check can be retried from Home.
      await savePhoto(ctx.wallet, ctx.dayNum, ch.idx, photo.bytes).catch(() => {});
      await verify(ch, photo, sealedS);
    } catch (e) {
      setPhase({ t: 'error', message: errorText(e), retryWords: true });
    }
  }

  const back = (
    <button className="btn-link" onClick={onDone}>
      ← Back
    </button>
  );

  if (phase.t === 'loading') {
    return (
      <main className="screen">
        {back}
        <Spinner label="Getting fresh words…" />
      </main>
    );
  }

  if (phase.t === 'error') {
    return (
      <main className="screen">
        {back}
        <ErrorBox message={phase.message}>
          {phase.retryWords && (
            <button className="btn btn-primary" onClick={() => void getWords()}>
              Get new words
            </button>
          )}
        </ErrorBox>
      </main>
    );
  }

  if (phase.t === 'words') {
    const { ch } = phase;
    const left = Math.max(0, ch.leftMs - (now - ch.at));
    const expired = left <= 0;
    return (
      <main className="screen">
        {back}
        <h1 className="title">{ch.idx === 0 ? 'Write these 3 words on the board' : 'Add these 3 words under the others'}</h1>
        <Board words={ch.words} prior={ch.prior} faded={expired} />
        <div className="timer-row">
          <Ring msLeft={left} totalMs={ch.totalMs} />
          <p className="timer-hint">
            {expired ? 'Time is up for these words.' : 'Write them big, then take a photo of the class with the board.'}
          </p>
        </div>
        {expired ? (
          <button className="btn btn-primary" onClick={() => void getWords()}>
            Get new words
          </button>
        ) : (
          <>
            <input
              ref={fileRef}
              className="sr-only"
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(e) => void onFile(e.target.files?.[0], ch)}
            />
            <button className="btn btn-primary" onClick={() => fileRef.current?.click()}>
              I wrote them — take photo
            </button>
          </>
        )}
      </main>
    );
  }

  if (phase.t === 'sending') {
    return (
      <main className="screen">
        {phase.photo && <img className="thumb" src={phase.photo.url} alt="Your class photo" />}
        <Spinner label="Sealing your photo…" />
      </main>
    );
  }

  const { ch, photo, sealedS, result, error } = phase;
  const rows = result ? checkRows(result, ch.idx) : [];
  const pass = result ? checksPass(result.flags) : false;
  return (
    <main className="screen">
      <div className="recorded" role="status">
        <strong>Recorded ✓</strong> — photo sealed {sealedS} s after the words appeared
      </div>
      <img className="thumb" src={photo.url} alt="Your class photo" />
      {!result && !error && <Spinner label="Checking the photo…" />}
      {error && (
        <ErrorBox message={`Couldn't check the photo: ${error}`}>
          <button className="btn btn-primary" onClick={() => void verify(ch, photo, sealedS)}>
            Try again
          </button>
          <button className="btn-link" onClick={onDone}>
            Check it later from Home
          </button>
        </ErrorBox>
      )}
      {result && (
        <>
          <CheckList rows={rows} />
          <div
            className={`verdict reveal ${pass ? 'pass' : 'fail'}`}
            style={{ animationDelay: `${rows.length * 450}ms` }}
            role="status"
          >
            {pass ? 'All checks passed' : 'Some checks failed'}
          </div>
          {!pass && result.reasons?.length > 0 && (
            <ul className="reasons">
              {result.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
          <button className="btn btn-primary" onClick={onDone}>
            Done
          </button>
        </>
      )}
    </main>
  );
}
