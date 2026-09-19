import type { Lang } from '@chalk/shared';
import { useState, type FormEvent } from 'react';
import { registerTeacher, type Ctx } from './flow.ts';
import { ErrorBox, errorText, Spinner } from './ui.tsx';

const LANG_LABELS: Record<Lang, string> = { en: 'English', sw: 'Kiswahili' };

export function Setup({
  ctx,
  initialLang,
  onDone,
}: {
  ctx: Omit<Ctx, 'lang'>;
  initialLang: Lang | null;
  onDone: (lang: Lang, schoolId: number) => void;
}) {
  const [lang, setLang] = useState<Lang | null>(initialLang);
  const [school, setSchool] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const schoolId = /^\d{1,9}$/.test(school.trim()) ? Number(school.trim()) : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!lang || schoolId === null) return;
    setBusy(true);
    setError(null);
    try {
      await registerTeacher({ ...ctx, lang }, schoolId);
      onDone(lang, schoolId);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="screen">
      <h1 className="brand">Chalk Chain</h1>
      <p className="lede">Prove your class happened: write 3 words on the board, take one photo.</p>
      <form className="stack" onSubmit={submit}>
        <fieldset className="stack">
          <legend className="label">Words language</legend>
          <div className="choice-row">
            {(Object.keys(LANG_LABELS) as Lang[]).map((l) => (
              <button
                type="button"
                key={l}
                className={`choice${lang === l ? ' selected' : ''}`}
                aria-pressed={lang === l}
                onClick={() => setLang(l)}
              >
                {LANG_LABELS[l]}
              </button>
            ))}
          </div>
        </fieldset>
        <label className="stack">
          <span className="label">School number</span>
          <input
            className="field"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            placeholder="e.g. 1042"
            value={school}
            onChange={(e) => setSchool(e.target.value)}
          />
        </label>
        {error && <ErrorBox message={error} />}
        {busy ? (
          <Spinner label="Setting up…" />
        ) : (
          <button className="btn btn-primary" type="submit" disabled={!lang || schoolId === null}>
            Start
          </button>
        )}
      </form>
    </main>
  );
}
