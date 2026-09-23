import { useEffect, useState } from 'react';
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

/** The stem each intent leaves in the composer, and the key for its label. */
const INTENTS = [
  { key: 'home.intent.research', stem: 'Research ' },
  { key: 'home.intent.create',   stem: 'Create ' },
  { key: 'home.intent.analyze',  stem: 'Analyze ' },
  { key: 'home.intent.automate', stem: 'Automate ' },
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
    <div className="mt-3 flex flex-wrap justify-center gap-2 px-6">
      {INTENTS.map(({ key, stem }) => (
        <button
          key={key}
          type="button"
          onClick={() => onPick(stem)}
          className="px-4 py-1.5 rounded-full border border-border-default bg-bg-surface/70 hover:bg-bg-hover text-sm text-text-secondary transition-colors cursor-pointer"
        >
          {t(key)}
        </button>
      ))}
    </div>
  );
}

/** Exported for the test: the order is part of the claim, not an accident. */
export const INTENT_KEYS = INTENTS.map((i) => i.key);
