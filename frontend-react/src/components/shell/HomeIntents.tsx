import { useEffect, useState } from 'react';
import { ArrowUpRight, BarChart3, PenLine, Repeat, Search } from 'lucide-react';
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
 * Each one opens five everyday jobs under it. It used to drop only its verb
 * ("Automate ") into the composer, and a person who does not know what to ask
 * stopped right there (24 Oct): most people do not know what they need, so
 * the product has to. A job fills the composer and stops; sending on click
 * would be the product guessing the sentence, which the contract forbids.
 */

/** Each intent's label and hint keys, and the jobs it offers. Jobs are ones the
 *  agent can do today with its own tools: nothing here needs a connector. */
const INTENTS = [
  { key: 'home.intent.research', hint: 'home.intent.research.hint', icon: Search, jobs: [
    'Find the three best-reviewed vacuum cleaners under $200 and tell me why each one stands out',
    'Plan a cheap weekend trip for two next month: where to go, how to get there and what it costs',
    'Compare mobile phone plans and tell me which one is cheapest for about 20 GB a month',
    'What happened in the news this week? Give me the five main stories in plain words',
    'Find a simple recipe I can cook tonight with chicken, rice and a few vegetables',
  ] },
  { key: 'home.intent.create', hint: 'home.intent.create.hint', icon: PenLine, jobs: [
    'Write a polite email asking my landlord to fix the heating this week',
    'Make a weekly meal plan for my family, with a shopping list',
    'Help me make a one-page CV. Ask me about my work first',
    'Write a short, warm birthday message for my mom',
    'Make a poster for a garage sale on Saturday morning',
  ] },
  { key: 'home.intent.analyze', hint: 'home.intent.analyze.hint', icon: BarChart3, jobs: [
    'I will attach a PDF. Tell me the five things I need to know from it',
    'I will attach my bank statement. Show me where most of my money goes',
    'I will attach a contract. Point out anything risky before I sign it',
    'I will attach a spreadsheet. Turn it into a chart and tell me what stands out',
    'I will paste a long email thread. Tell me what I am expected to do',
  ] },
  { key: 'home.intent.automate', hint: 'home.intent.automate.hint', icon: Repeat, jobs: [
    'Sort my Downloads folder into folders: documents, images, videos and installers',
    'Find the biggest files on my computer I probably do not need. Ask me before deleting anything',
    'Rename the photos in a folder by the date they were taken',
    'Fill in an online form for me. I will tell you the page and the details',
    'Check three online shops for the price of a product and tell me where it is cheapest',
  ] },
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
    // Same frame as the intent cards below the composer: centered, as wide as the composer.
    <div className="mx-auto mt-4 w-full max-w-2xl px-4">
      <div className="rounded-3xl border border-border-default bg-(--surface-typing) p-5 text-left shadow-lg">
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
    </div>
  );
}

export function HomeIntents({ onPick }: { onPick: (text: string) => void }) {
  const t = useT();
  const hasModel = useHasAnyModel();
  const [open, setOpen] = useState<(typeof INTENTS)[number]['key'] | null>(null);
  if (hasModel === false) return <SetupCard />;
  const jobs = INTENTS.find((i) => i.key === open)?.jobs;
  return (
    <div className="mx-auto mt-4 w-full max-w-2xl px-4">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {INTENTS.map(({ key, hint, icon: Icon }) => (
          <button
            key={key}
            type="button"
            aria-label={t(key)}
            aria-expanded={open === key}
            onClick={() => setOpen(open === key ? null : key)}
            className={`flex flex-col items-start gap-2 rounded-2xl border bg-bg-surface p-3.5 text-left transition-colors hover:border-brand/40 cursor-pointer ${open === key ? 'border-brand/60' : 'border-border-default'}`}
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-bg-active text-brand"><Icon size={16} /></span>
            <span className="text-sm font-semibold text-text-primary">{t(key)}</span>
            <span className="text-2xs leading-snug text-text-disabled">{t(hint)}</span>
          </button>
        ))}
      </div>
      {jobs ? (
        <ul className="mt-3 flex flex-col overflow-hidden rounded-2xl border border-border-default bg-bg-surface">
          {jobs.map((job, i) => (
            <li key={job} className={i > 0 ? 'border-t border-border-subtle' : undefined}>
              <button
                type="button"
                onClick={() => onPick(job)}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary cursor-pointer"
              >
                <span className="min-w-0 flex-1">{job}</span>
                <ArrowUpRight size={14} className="shrink-0 text-text-disabled" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
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
      )}
    </div>
  );
}

/** Exported for the test: the order is part of the claim, not an accident. */
export const INTENT_KEYS = INTENTS.map((i) => i.key);
