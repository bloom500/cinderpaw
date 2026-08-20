import { useT } from '@/lib/i18n';

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

export function HomeIntents({ onPick }: { onPick: (text: string) => void }) {
  const t = useT();
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
