import { useEffect, useState } from 'react';
import { BarChart3, PenLine, Repeat, Search } from 'lucide-react';
import { useT } from '@/lib/i18n';
import { tauri } from '@/lib/tauri';
import { signInWithOpenRouter } from '@/lib/openrouterSignIn';

/**
 * The four intents, under the composer.
 *
 * They replace three suggestions drawn at random from a list of twenty. The
 * difference is not cosmetic: a set that reshuffles on every visit says "here
 * are some things you could type", while a fixed four says "this is what this
 * product is for". Only the second is a claim, and only a claim can be wrong,
 * which is what makes it worth making.
 *
 * Each one drops a verb into the composer and stops there. Sending on click
 * would be the product guessing the sentence, which is the one thing the
 * contract says it must never do to the composer.
 */

/** The stem each intent leaves in the composer, and the keys for its label and hint. */
const INTENTS = [
  { key: 'home.intent.research', hint: 'home.intent.research.hint', stem: 'Research ', icon: Search },
  { key: 'home.intent.create',   hint: 'home.intent.create.hint',   stem: 'Create ',   icon: PenLine },
  { key: 'home.intent.analyze',  hint: 'home.intent.analyze.hint',  stem: 'Analyze ',  icon: BarChart3 },
  { key: 'home.intent.automate', hint: 'home.intent.automate.hint', stem: 'Automate ', icon: Repeat },
] as const;

/**
 * The five suggestion chips under the intents (spec 5, "all five stay",
 * 27 Sep). Like the intents they fill the composer and stop; the words are
 * the person's to finish or send.
 */
export const SUGGESTIONS = [
  'Plan my week',
  'Summarize a PDF',
  'Compare three laptops',
  'Draft an email',
  'Explain a topic simply',
] as const;

/**
 * Whether anything can answer yet: a chat model on disk, or a cloud key.
 * `null` while asking, so a working install never flashes the setup card.
 */
function useHasAnyModel(): boolean | null {
  const [has, setHas] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    const check = () => Promise.all([
      tauri.models.list().then((all) => all.some((m) => !m.is_embedding)).catch(() => true),
      tauri.raw.getByokSettings().then((ps) => ps.some((p) => p.has_api_key)).catch(() => true),
    ]).then(([local, cloud]) => { if (live) setHas(local || cloud); });
    void check();
    // A key saved in Settings, or a download finishing, while this screen is up.
    const id = setInterval(check, 5000);
    return () => { live = false; clearInterval(id); };
  }, []);
  return has;
}

/**
 * On a machine with no model, the home screen IS the setup: one button that
 * works on any computer, and the local route for people who want it. The
 * intent chips would only lead to a message nothing can answer.
 */
function SetupCard() {
  const [busy, setBusy] = useState(false);
  return (
    <div className="mt-3 mx-6 w-full max-w-xl rounded-3xl border border-border-default bg-(--surface-typing) p-5 text-left shadow-lg">
      <p className="text-base font-semibold text-text-primary">Cinderpaw needs a model to think with.</p>
      <p className="mt-1 text-sm text-text-secondary">
        Sign in with OpenRouter and it answers right away, on any computer. Or download a model that runs here, free and private, if this machine is strong enough.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => { setBusy(true); void signInWithOpenRouter().finally(() => setBusy(false)); }}
          className="rounded-xl bg-brand px-4 py-2 text-sm font-medium text-brand-foreground hover:opacity-90 disabled:opacity-60 cursor-pointer"
        >
          {busy ? 'Finish in your browser…' : 'Sign in with OpenRouter'}
        </button>
        <button
          type="button"
          // Loaded on click: importing the router here pulls the whole app into
          // anything that renders the home screen, tests included.
          onClick={() => { void import('@/router').then((m) => m.router.navigate('/models')); }}
          className="rounded-xl border border-border-default px-4 py-2 text-sm text-text-secondary hover:bg-bg-hover cursor-pointer"
        >
          Download a model
        </button>
      </div>
    </div>
  );
}

export function HomeIntents({ onPick }: { onPick: (text: string) => void }) {
  const t = useT();
  const hasModel = useHasAnyModel();
  if (hasModel === false) return <SetupCard />;
  return (
    <div className="mx-auto mt-4 w-full max-w-2xl px-4">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {INTENTS.map(({ key, hint, stem, icon: Icon }) => (
          <button
            key={key}
            type="button"
            aria-label={t(key)}
            onClick={() => onPick(stem)}
            className="flex flex-col items-start gap-2 rounded-2xl border border-border-default bg-bg-surface p-3.5 text-left transition-colors hover:border-brand/40 cursor-pointer"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-bg-active text-brand"><Icon size={16} /></span>
            <span className="text-sm font-semibold text-text-primary">{t(key)}</span>
            <span className="text-2xs leading-snug text-text-disabled">{t(hint)}</span>
          </button>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap justify-center gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            className="rounded-full border border-border-default px-3 py-1 text-2xs text-text-muted transition-colors hover:bg-text-primary/5 hover:text-text-secondary cursor-pointer"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Exported for the test: the order is part of the claim, not an accident. */
export const INTENT_KEYS = INTENTS.map((i) => i.key);
