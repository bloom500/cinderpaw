/**
 * OnboardingWizard — first-run experience, drawn from Darius's five boards
 * (Moodboard/Components/onboarding 1-5.png, 1 Oct 2026).
 *
 *   1. Welcome          — what Cinderpaw is, in four cards
 *   2. Provider         — Cloud, Hugging Face or Local, with the real setup under each
 *   3. Connect          — the real integrations, "+" opens the same form Settings uses
 *   4. Workspace        — a drawing of the app, so the first screen after this is familiar
 *   5. Done             — what was set up (only what really was), then the chat
 *
 * The name step is gone on purpose: the boards have none, and the agent asks
 * in the first conversation. Names can still be changed in Settings.
 *
 * Skippable. If the user dismisses, defaults are used and they can
 * re-open the wizard from Settings later.
 */

import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowRight, ArrowLeft, ArrowUp, AudioLines, BarChart3, Brain, Check, ChevronRight, Cloud, Cpu, Database, Download, ExternalLink, Eye, EyeOff, FileText, Globe, Gpu, Laptop, Layers, Loader2, MemoryStick, Paperclip, PenLine, Search, Settings, Shield, ShieldAlert, ShieldCheck, Sparkles, Star, Wrench, type LucideIcon } from 'lucide-react';
import { useOnboarding } from '@/stores/onboarding';
import { useSystemInfo } from '@/stores/systemInfo';
import { useDownload } from '@/stores/download';
import { useSettings } from '@/stores/settings';
import { useModel } from '@/stores/model';
import { useCinderpawStore } from '@/stores/cinderpaw';
import { useCatalog } from '@/stores/catalog';
import { useNotifications } from '@/stores/notifications';
import { recommendModel } from '@/lib/hardwareRecommendation';
import { tauri, type DiskEncryptionStatus, type SetupCandidate, type SetupVerifyOutcome } from '@/lib/tauri';
import { CinderpawMascot } from '@/components/chat/mascot/CinderpawMascot';
import type { MascotState } from '@/components/chat/mascot/frames';
import { BrandLogo } from '@/lib/brandLogos';
import { ConnectStep } from './ConnectStep';
import { cn, SECONDARY_BUTTON } from '@/lib/utils';

const stepVariants = {
  enter: { opacity: 0, y: 12 },
  center: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -12 },
};

/** The mascot's pose on each board, in step order. */
const ART: MascotState[] = ['wave', 'curious', 'excited', 'idle', 'celebrate'];

const PRIMARY_BUTTON =
  'inline-flex items-center gap-2.5 rounded-2xl bg-brand px-7 py-3.5 text-base font-medium text-on-brand shadow-lg shadow-brand/25 transition-colors hover:bg-brand/90';

export function OnboardingWizard() {
  const navigate = useNavigate();
  const active = useOnboarding((s) => s.active);
  const step = useOnboarding((s) => s.step);
  const totalSteps = useOnboarding((s) => s.totalSteps);
  const prev = useOnboarding((s) => s.prev);
  const next = useOnboarding((s) => s.next);
  const skip = useOnboarding((s) => s.skip);
  const finish = useOnboarding((s) => s.finish);

  if (!active) return null;
  const isFirst = step === 0;
  const isLast = step === totalSteps - 1;

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-bg-primary"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
    >
      <div className="mx-auto flex min-h-full max-w-6xl flex-col px-4 py-6 sm:px-10 sm:py-8">
        <header className="flex items-center gap-2" aria-hidden>
          <CinderpawMascot state="idle" width={32} />
          <span className="font-display text-xl text-text-primary">Cinderpaw</span>
        </header>

        <div className="grid flex-1 items-center gap-10 py-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
          <div className="min-w-0">
            <StepCounter step={step} total={totalSteps} />
            <AnimatePresence mode="wait">
              <motion.div
                key={step}
                variants={stepVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ duration: 0.18, ease: 'easeOut' }}
                className="mt-6"
              >
                {step === 0 && <WelcomeStep />}
                {step === 1 && <ProviderStep />}
                {step === 2 && <ConnectStep />}
                {step === 3 && <WorkspaceStep />}
                {step === 4 && <DoneStep />}
              </motion.div>
            </AnimatePresence>

            <nav className="mt-8 flex flex-wrap items-center gap-4">
              {!isFirst && (
                <button type="button" onClick={prev} className={cn(SECONDARY_BUTTON, 'rounded-2xl px-5 py-3 text-base')}>
                  <ArrowLeft size={16} /> Back
                </button>
              )}
              {isLast ? (
                <button
                  type="button"
                  // Navigate to /chat explicitly rather than relying on it being the
                  // route behind the overlay — the provider step can leave the router
                  // elsewhere (e.g. a deep-link to /models). Finish closes the wizard.
                  onClick={() => { navigate('/chat'); void finish(); }}
                  className={PRIMARY_BUTTON}
                >
                  Start exploring <ArrowRight size={16} />
                </button>
              ) : (
                <button type="button" onClick={next} className={PRIMARY_BUTTON}>
                  {isFirst ? 'Get started' : 'Continue'} <ArrowRight size={16} />
                </button>
              )}
              {isFirst && (
                <button
                  type="button"
                  onClick={skip}
                  className="text-base text-text-muted underline underline-offset-4 hover:text-text-primary"
                  aria-label="Skip onboarding"
                >
                  Skip
                </button>
              )}
            </nav>
          </div>

          {/* The drawing beside each board. Decoration only, and hidden on a
              narrow window, where the steps need the whole width. */}
          <div className="hidden justify-center lg:flex" aria-hidden>
            <AnimatePresence mode="wait">
              <motion.div
                key={step}
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.25, ease: 'easeOut' }}
              >
                {step === 1 ? <ModelArt /> : step === 2 ? <ConnectArt /> : step === 3 ? <WorkspaceArt /> : (
                  <CinderpawMascot state={ART[step] ?? 'wave'} width={340} />
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}

function StepCounter({ step, total }: { step: number; total: number }) {
  return (
    <div className="flex items-center gap-5" aria-label={`Step ${step + 1} of ${total}`}>
      <span className="text-xs font-medium tracking-[0.22em] text-text-muted">{step + 1} OF {total}</span>
      <span className="flex items-center" aria-hidden>
        {Array.from({ length: total }, (_, i) => (
          <Fragment key={i}>
            {i > 0 && <span className={cn('h-px w-5', i <= step ? 'bg-brand/50' : 'bg-border-default')} />}
            <span
              className={cn(
                'rounded-full transition-all duration-300',
                i === step ? 'size-3.5 bg-brand' : i < step ? 'size-2 bg-brand/50' : 'size-2 bg-border-default',
              )}
            />
          </Fragment>
        ))}
      </span>
    </div>
  );
}

/** A board's title, its serif lead line, and the plain sentence under it. */
export function StepIntro({ title, lead, body }: { title: ReactNode; lead: string; body: string }) {
  return (
    <div>
      <h1 id="onboarding-title" className="font-display text-5xl leading-[1.02] tracking-tight text-text-primary sm:text-6xl">
        {title}
      </h1>
      <p className="mt-4 font-display text-2xl leading-snug text-text-primary sm:text-3xl">{lead}</p>
      <p className="mt-3 max-w-xl text-lg leading-relaxed text-text-muted">{body}</p>
    </div>
  );
}

function FeatureCards({ items }: { items: { icon: LucideIcon; title: string; line: string }[] }) {
  return (
    <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map(({ icon: Icon, title, line }) => (
        <div key={title} className="rounded-2xl border border-border-default bg-bg-surface px-3 py-4 text-center">
          <Icon size={28} className="mx-auto text-brand" />
          <p className="mt-2.5 font-display text-base text-text-primary">{title}</p>
          <p className="mt-1 text-xs leading-relaxed text-text-muted">{line}</p>
        </div>
      ))}
    </div>
  );
}

// ── Step 1: Welcome ─────────────────────────────────────────────────────────

function WelcomeStep() {
  return (
    <div>
      <StepIntro
        title={<>Welcome to<br />Cinderpaw</>}
        lead="A little wild. A lot to learn."
        body="Your adaptive AI companion for exploring, creating, and automating work."
      />
      <FeatureCards
        items={[
          { icon: Layers, title: 'Models', line: 'Use the best models for your goals.' },
          { icon: Wrench, title: 'Tools', line: 'Get things done with powerful tools.' },
          { icon: Database, title: 'Memory', line: 'Remembers what matters to you.' },
          { icon: AudioLines, title: 'Voice', line: 'Chat naturally, with your voice.' },
        ]}
      />
    </div>
  );
}

// ── Step 4: Workspace ───────────────────────────────────────────────────────

function WorkspaceStep() {
  return (
    <StepIntro
      title={<>Meet your<br />workspace</>}
      lead="Everything you need, without the clutter."
      body="Chat, browse, build artifacts, manage models, and track tasks from one calm interface."
    />
  );
}

// ── The drawings beside the boards ──────────────────────────────────────────

/** A raised tile with a label, floating beside the mascot. */
function Tile({ children, label, className }: { children: ReactNode; label: string; className?: string }) {
  return (
    <span className={cn('absolute flex w-28 flex-col items-center gap-1.5 rounded-2xl border border-border-default bg-bg-elevated px-3 py-3 shadow-lg', className)}>
      {children}
      <span className="font-display text-sm text-text-primary">{label}</span>
    </span>
  );
}

function ModelArt() {
  return (
    <div className="relative h-[420px] w-[440px]">
      <span className="absolute bottom-0 right-0"><CinderpawMascot state="curious" width={300} /></span>
      <Tile label="Cloud" className="left-6 top-4 -rotate-6"><Cloud size={28} className="text-brand" /></Tile>
      <Tile label="Hugging Face" className="left-0 top-44 rotate-3"><BrandLogo id="huggingface" name="Hugging Face" /></Tile>
      <Tile label="Local" className="bottom-6 right-0 rotate-6"><Laptop size={28} className="text-text-secondary" /></Tile>
    </div>
  );
}

/** The services the Connect board can really connect, around the mascot. */
const ORBIT: { id: string; name: string }[] = [
  { id: 'google_docs', name: 'Google Docs' }, { id: 'slack', name: 'Slack' }, { id: 'telegram', name: 'Telegram' },
  { id: 'notion', name: 'Notion' }, { id: 'github', name: 'GitHub' }, { id: 'discord', name: 'Discord' },
];

function ConnectArt() {
  const r = 190;
  return (
    <div className="relative size-[440px]">
      <span className="absolute inset-8 rounded-full border-2 border-dashed border-brand/25" />
      {ORBIT.map((o, i) => {
        const a = (i / ORBIT.length) * Math.PI * 2 - Math.PI / 2;
        return (
          <span
            key={o.id}
            className="absolute -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-bg-elevated p-2 shadow-lg"
            style={{ left: 220 + Math.cos(a) * r, top: 220 + Math.sin(a) * r }}
          >
            <BrandLogo id={o.id} name={o.name} />
          </span>
        );
      })}
      <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"><CinderpawMascot state="excited" width={220} /></span>
    </div>
  );
}

/** The app, drawn small: the sidebar, the home screen and the Context panel. */
function WorkspaceArt() {
  const nav: [LucideIcon, string][] = [[PenLine, 'New Chat'], [FileText, 'Artifacts'], [Globe, 'Browser'], [Layers, 'Models']];
  const context: [LucideIcon, string, string][] = [[Globe, 'Current Page', 'cinderpaw.com'], [FileText, 'Selected Text', '3 snippets'], [Database, 'Relevant Memory', '2 memories']];
  return (
    <div className="relative w-[520px] pb-16 pt-14">
      <Callout className="left-4 top-0">All in one place. Chat, browse, build from the sidebar.</Callout>
      <Callout className="right-0 top-0">Helpful context, within reach.</Callout>
      <div className="flex overflow-hidden rounded-2xl border border-border-default bg-bg-elevated text-micro shadow-xl">
        <div className="w-32 shrink-0 space-y-1 border-r border-border-subtle p-3">
          {nav.map(([Icon, label], i) => (
            <p key={label} className={cn('flex items-center gap-2 rounded-lg px-2 py-1.5', i === 0 ? 'bg-brand/10 text-brand' : 'text-text-secondary')}>
              <Icon size={12} /> {label}
            </p>
          ))}
          <p className="flex items-center gap-2 px-2 py-1.5 text-text-secondary"><Settings size={12} /> Settings</p>
        </div>
        <div className="flex flex-1 flex-col items-center gap-3 p-4">
          <CinderpawMascot state="idle" width={44} />
          <p className="font-display text-base text-text-primary">Good morning!</p>
          <div className="w-full rounded-xl border border-border-default bg-bg-surface p-2.5">
            <p className="text-text-muted">Ask anything…</p>
            <p className="mt-3 flex items-center gap-2 text-text-muted">
              <Paperclip size={12} /><Globe size={12} /><span className="flex-1" />
              <span className="rounded-md bg-brand/15 p-1 text-brand"><ArrowUp size={12} /></span>
            </p>
          </div>
          <div className="grid w-full grid-cols-2 gap-2">
            <p className="rounded-xl border border-border-subtle p-2"><span className="flex items-center gap-1.5 text-text-primary"><Brain size={12} className="text-brand" /> Agent Pulse</span><span className="text-text-muted">What your agent is doing.</span></p>
            <p className="rounded-xl border border-border-subtle p-2"><span className="flex items-center gap-1.5 text-text-primary"><Database size={12} className="text-brand" /> Memory Peek</span><span className="text-text-muted">Relevant context.</span></p>
          </div>
        </div>
        <div className="w-36 shrink-0 space-y-1.5 border-l border-border-subtle p-3">
          <p className="font-medium text-text-primary">Context</p>
          {context.map(([Icon, title, line]) => (
            <p key={title} className="flex items-start gap-2 rounded-lg border border-border-subtle p-1.5">
              <Icon size={12} className="mt-0.5 shrink-0 text-text-secondary" />
              <span><span className="block text-text-primary">{title}</span><span className="text-text-muted">{line}</span></span>
            </p>
          ))}
        </div>
      </div>
      <Callout className="bottom-0 left-28">A calm place to create. Chat, plan, and act with powerful tools.</Callout>
    </div>
  );
}

function Callout({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('absolute max-w-[220px] rounded-xl border border-border-default bg-bg-elevated px-3 py-2 text-xs leading-snug text-text-secondary shadow-md', className)}>
      {children}
    </span>
  );
}

// ── Step 3: Provider — "Choose your brain" ──────────────────────────────────
// (render order: Welcome → Personalize → Provider → Showcase → Done)

// ponytail: pinned curated GGUFs per hardware tier (keys match
// recommendModel().sizeClass exactly — the key describes the hardware budget,
// the model it maps to can be any size). Calibration knob — re-verify these
// repos/files resolve on Hugging Face before each release; swap when a better
// small model ships. An unresolvable repo makes the one-click download fail.
// `approxSize` is the real Q4_K_M download size (shown on the button) — keep it
// in sync when swapping models. All 4 repos + exact Q4_K_M filenames verified
// live on HF 2026-07-10 (huggingface.co/api/models/<repo>/tree/main).
const TIER_MODELS: Record<string, { repoId: string; filename: string; label: string; approxSize: string }> = {
  '1–2B':   { repoId: 'bartowski/Qwen_Qwen3.5-2B-GGUF',  filename: 'Qwen_Qwen3.5-2B-Q4_K_M.gguf',  label: 'Qwen3.5 2B',  approxSize: '~1.5 GB' },
  '3–4B':   { repoId: 'bartowski/Qwen_Qwen3.5-4B-GGUF',  filename: 'Qwen_Qwen3.5-4B-Q4_K_M.gguf',  label: 'Qwen3.5 4B',  approxSize: '~2.5 GB' },
  '7–8B':   { repoId: 'bartowski/Qwen_Qwen3.5-9B-GGUF',  filename: 'Qwen_Qwen3.5-9B-Q4_K_M.gguf',  label: 'Qwen3.5 9B',  approxSize: '~5.5 GB' },
  '13–14B': { repoId: 'bartowski/Qwen_Qwen3.5-27B-GGUF', filename: 'Qwen_Qwen3.5-27B-Q4_K_M.gguf', label: 'Qwen3.5 27B', approxSize: '~16.5 GB' },
};

// A short, friendly subset of ByokTab's PROVIDER_DEFS — the rest stay in
// Settings → Cloud Keys. `id` MUST match a PROVIDER_DEFS id so the saved key
// lines up. Gemini + OpenRouter have free tiers (zero-budget friendly).
const CURATED_PROVIDERS: {
  id: string;
  name: string;
  console: string;
  keyPlaceholder: string;
  free?: boolean;
  /** Cost/availability caveat shown under the steps — saves the user from a
   *  confusing "quota exceeded" on the paid providers. */
  note: string;
  steps: string[];
}[] = [
  {
    id: 'openai', name: 'OpenAI', console: 'https://platform.openai.com/api-keys',
    keyPlaceholder: 'sk-...',
    note: 'New accounts get ~$5 free credit (no card, 3-month expiry); after that, add a prepaid balance under Billing. A ChatGPT Plus/Pro subscription does not cover API keys.',
    steps: [
      'Sign in at platform.openai.com',
      'Settings → API keys → "Create new secret key"',
      'Copy the key now (it\'s shown only once) and paste it below',
    ],
  },
  {
    id: 'anthropic', name: 'Anthropic (Claude)', console: 'https://console.anthropic.com/settings/keys',
    keyPlaceholder: 'sk-ant-...',
    note: 'Paid. Add ~$5 credit under Billing before the key will work.',
    steps: [
      'Sign in at console.anthropic.com',
      'Settings → API keys → "Create Key"',
      'Copy the key now (it\'s shown only once) and paste it below',
    ],
  },
  {
    id: 'google', name: 'Google Gemini', console: 'https://aistudio.google.com/apikey', free: true,
    keyPlaceholder: 'AIza...',
    note: 'Free tier, no credit card needed.',
    steps: [
      'Sign in at aistudio.google.com with any Google account',
      'Click "Get API key" → "Create API key"',
      'Copy the key and paste it below',
    ],
  },
  {
    id: 'openrouter', name: 'OpenRouter', console: 'https://openrouter.ai/keys', free: true,
    keyPlaceholder: 'sk-or-...',
    note: 'Free models available (look for ":free"), no credit card needed.',
    steps: [
      'Sign in at openrouter.ai (Google or email)',
      'Profile menu → Keys → "Create Key"',
      'Copy the key now (it\'s shown only once) and paste it below',
    ],
  },
];

/**
 * Make a freshly keyed provider the model that answers.
 *
 * Chat mode reads `cloudModel`; agent mode asks the sidecar. Both are set,
 * so whichever composer the person lands in, the provider they configured is
 * the one on the line. The sidecar half is best effort: during onboarding it
 * may still be booting, and the chat half does not depend on it. Returns the
 * model id that was pinned, or null when the provider has none to pin.
 */
export function pointChatAt(providerId: string, providerName: string, modelId: string | null): string | null {
  if (!modelId) return null;
  useModel.getState().setCloudModel({ providerId, providerName, modelId });
  void useCinderpawStore.getState().setModel({ source: 'byok', providerId, model: modelId }).catch(() => {});
  return modelId;
}

export function ProviderStep() {
  const navigate = useNavigate();
  const defer = useOnboarding((s) => s.defer);
  const sysInfo = useSystemInfo((s) => s.info);
  const fetchSysInfo = useSystemInfo((s) => s.fetch);
  useEffect(() => { void fetchSysInfo(); }, [fetchSysInfo]);
  // Cloud first, on purpose. Cinderpaw's tools fumble on anything under ~27B,
  // and most machines cannot run 27B, so "local" is the right first day only
  // for a machine that fits the top tier; the LocalBranch says so per tier.
  const localFits = recommendModel(sysInfo)?.sizeClass === '13–14B';
  const [choice, setChoice] = useState<'cloud' | 'hub' | 'local'>('cloud');

  const hardware: [LucideIcon, string, string][] = sysInfo
    ? [
        [Cpu, 'CPU', `${sysInfo.cores} cores`],
        [Gpu, 'GPU', sysInfo.gpu_name || 'None'],
        [MemoryStick, 'RAM', `${Math.round(sysInfo.ram_total_mb / 1024)} GB`],
      ]
    : [];

  return (
    <div>
      <StepIntro
        title="Choose your model"
        lead="Cloud, Hugging Face, or Local. Pick what fits your workflow."
        body="Cinderpaw works with hosted providers and local models on your machine. You can change this anytime in Models."
      />

      <div className="mt-6"><DetectedSection /></div>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <ForkCard
          icon={<Cloud size={28} className="text-brand" />}
          title="Cloud"
          subtitle="Get started quickly with top models in the cloud."
          badge="Fast & easy"
          selected={choice === 'cloud'}
          onClick={() => setChoice('cloud')}
        />
        <ForkCard
          icon={<BrandLogo id="huggingface" name="Hugging Face" className="size-8 border-0 bg-transparent" />}
          title="Hugging Face"
          subtitle="Browse and use thousands of open source models."
          badge="Wide selection"
          selected={choice === 'hub'}
          onClick={() => setChoice('hub')}
        />
        <ForkCard
          icon={<Laptop size={28} className="text-text-secondary" />}
          title="Local"
          subtitle="Run models on your own machine, for more control."
          selected={choice === 'local'}
          onClick={() => setChoice('local')}
        >
          {hardware.length > 0 && (
            <span className="mt-3 grid grid-cols-3 divide-x divide-border-subtle rounded-xl border border-border-subtle text-left">
              {hardware.map(([Icon, label, value]) => (
                <span key={label} className="min-w-0 px-1.5 py-1">
                  <span className="flex items-center gap-1 text-micro font-medium text-text-secondary"><Icon size={12} /> {label}</span>
                  <span className="block truncate text-micro text-text-muted" title={value}>{value}</span>
                </span>
              ))}
            </span>
          )}
        </ForkCard>
      </div>

      <p className="mt-3 flex items-center gap-2 rounded-full bg-brand/10 px-4 py-2 text-sm text-text-primary">
        <Star size={16} className="fill-brand text-brand" />
        <span><span className="font-medium text-brand">Recommended:</span> start with {localFits ? 'Local, your machine can run a model big enough' : 'Cloud'}</span>
      </p>

      <div className="mt-4">
        {choice === 'cloud' && <CloudBranch />}
        {choice === 'local' && <LocalBranch />}
        {choice === 'hub' && (
          <div className="rounded-lg border border-border-subtle bg-bg-primary/40 p-4 space-y-3">
            <p className="text-sm text-text-secondary leading-relaxed">
              Pick any open model from Hugging Face and Cinderpaw downloads it for you. The Models page shows which ones fit this machine.
            </p>
            <button
              type="button"
              onClick={() => { defer(); navigate('/models?tab=browse'); }}
              className="flex items-center gap-1 text-sm font-medium text-brand hover:underline"
            >
              Browse Hugging Face models <ChevronRight size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Guided-setup rung (OpenClaw parity, 2026-07-10): before asking the user
 * to choose, show what the machine already has — an enabled provider, a
 * GGUF on disk, an env API key, a running Ollama, or an OpenClaw config —
 * and verify the pick with a REAL completion before calling it ready.
 * The detection + persistence logic lives in cinderpaw-core (`setup_detect` /
 * `setup_verify`), the same ladder `cinderpaw setup` uses.
 */
function DetectedSection() {
  const [candidates, setCandidates] = useState<SetupCandidate[] | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, SetupVerifyOutcome>>({});

  useEffect(() => {
    tauri.raw
      .setupDetect()
      // The download rung is already the LocalBranch's one-click button —
      // listing it twice would duplicate the CTA.
      .then((c) => setCandidates(c.filter((x) => x.kind !== 'hardware_download')))
      .catch(() => setCandidates([]));
  }, []);

  if (!candidates?.length) return null;

  const useThis = async (c: SetupCandidate) => {
    setTestingId(c.id);
    try {
      const outcome = await tauri.raw.setupVerify(c, undefined, true);
      setResults((r) => ({ ...r, [c.id]: outcome }));
    } catch (e) {
      setResults((r) => ({
        ...r,
        [c.id]: { ok: false, status: 'unknown', message: String(e), persisted: false },
      }));
    } finally {
      setTestingId(null);
    }
  };

  return (
    <div className="rounded-lg border border-brand/30 bg-brand/5 p-4 space-y-2.5">
      <p className="text-xs font-medium text-brand flex items-center gap-1.5">
        <Sparkles size={14} /> Found on your machine
      </p>
      {candidates.map((c) => {
        const outcome = results[c.id];
        const isTesting = testingId === c.id;
        return (
          <div key={c.id} className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm text-text-primary truncate">{c.label}</p>
              <p className="text-xs text-text-muted truncate">
                {outcome && !outcome.ok ? (
                  <span className="text-error">{outcome.message}</span>
                ) : (
                  c.detail
                )}
              </p>
            </div>
            {outcome?.ok ? (
              <span className="flex items-center gap-1.5 text-xs text-success shrink-0">
                <Check size={14} /> ready, I'll use it ({outcome.message})
              </span>
            ) : isTesting ? (
              <span className="flex items-center gap-1.5 text-xs text-text-muted shrink-0">
                <Loader2 size={12} className="animate-spin" /> Testing a real completion…
              </span>
            ) : (
              <button
                type="button"
                onClick={() => void useThis(c)}
                disabled={testingId !== null}
                className="shrink-0 px-3 py-1.5 rounded-md bg-brand/15 text-brand text-xs font-medium hover:bg-brand/25 transition-colors disabled:opacity-50"
              >
                {outcome ? 'Retry' : 'Use this'}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ForkCard({
  icon, title, subtitle, badge, selected, onClick, children,
}: {
  icon: ReactNode; title: string; subtitle: string; badge?: string; selected: boolean; onClick: () => void; children?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        'flex flex-col items-center rounded-2xl border-2 bg-bg-surface p-4 text-center transition-colors',
        selected ? 'border-brand' : 'border-transparent hover:border-border-default',
      )}
    >
      <span className="flex size-14 items-center justify-center rounded-2xl bg-bg-elevated">{icon}</span>
      <span className="mt-3 font-display text-lg text-text-primary">{title}</span>
      <span className="mt-1 text-sm leading-snug text-text-muted">{subtitle}</span>
      {badge && (
        <span className="mt-3 flex items-center gap-1.5 rounded-full bg-bg-hover px-3 py-1 text-xs text-text-secondary">
          <span className={cn('size-1.5 rounded-full', selected ? 'bg-success' : 'bg-text-muted')} /> {badge}
        </span>
      )}
      {children}
    </button>
  );
}

function LocalBranch() {
  const navigate = useNavigate();
  const defer = useOnboarding((s) => s.defer);
  const sysInfo = useSystemInfo((s) => s.info);
  const fetchSysInfo = useSystemInfo((s) => s.fetch);
  useEffect(() => { void fetchSysInfo(); }, [fetchSysInfo]);

  const rec = recommendModel(sysInfo);
  // recommendModel().sizeClass keys map 1:1 to TIER_MODELS. Fall back to the
  // mid tier when detection isn't ready yet so the button is never dead.
  const model = (rec && TIER_MODELS[rec.sizeClass]) ?? TIER_MODELS['3–4B'];

  const active = useDownload((s) => s.active);
  const done = useDownload((s) => s.done);
  const error = useDownload((s) => s.error);
  const start = useDownload((s) => s.start);
  const isThisDownloading = active?.repoId === model.repoId;

  return (
    <div className="rounded-lg border border-border-subtle bg-bg-primary/40 p-4 space-y-3">
      {rec && <p className="text-sm text-text-secondary leading-relaxed">{rec.rationale}</p>}

      {done ? (
        <p className="flex items-center gap-2 text-sm text-success">
          <Check size={16} /> {model.label} is ready, I'll use it automatically.
        </p>
      ) : isThisDownloading ? (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-text-muted">
            <span className="flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> Downloading {model.label}…</span>
            <span>{Math.round((active?.progress ?? 0) * 100)}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-bg-hover overflow-hidden">
            <div className="h-full bg-brand transition-all" style={{ width: `${Math.round((active?.progress ?? 0) * 100)}%` }} />
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void start(model.repoId, model.filename)}
          disabled={!!active}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-brand text-on-brand text-sm font-medium hover:bg-brand/90 transition-colors disabled:opacity-50"
        >
          <Download size={14} /> Download {model.label} ({model.approxSize})
        </button>
      )}

      {error && <p className="text-xs text-error">Download failed: {error}</p>}

      {/*
        Audit M-R2 fix (2026-07-07): was `finish()` then `navigate()`, which
        persisted `completed: true` and closed the wizard forever. Calling
        `defer()` instead hides the wizard without persisting a completion
        record — the in-flight download keeps progressing under
        `useDownload` (a global store), and the wizard re-opens on next
        app launch since no completion record exists on disk.
      */}
      <button
        type="button"
        onClick={() => { defer(); navigate('/models'); }}
        className="flex items-center gap-1 text-xs text-text-muted hover:text-text-primary transition-colors"
      >
        Browse other models <ChevronRight size={12} />
      </button>
    </div>
  );
}

function CloudBranch() {
  const navigate = useNavigate();
  const defer = useOnboarding((s) => s.defer);
  const [selected, setSelected] = useState<string | null>(null);
  // Provider catalog comes from the shared useCatalog store (Phase 1
  // DoD). One fetch per app lifetime; other tabs (Phase 2 Connectors,
  // Settings → Cloud Keys) consume the same store without re-hitting
  // the gateway. The store carries `loaded=true, list=[]` on offline,
  // which is the same as the previous local useState behaviour so the
  // wizard degrades to its bundled CURATED_PROVIDERS gracefully.
  const catalogEntries = useCatalog((s) => s.providerCatalog);
  const catalogLoaded = useCatalog((s) => s.providerLoaded);
  const loadProvider = useCatalog((s) => s.loadProvider);

  useEffect(() => {
    void loadProvider();
  }, [loadProvider]);

  // Decision C: catalog overrides CURATED_PROVIDERS. Curated providers
  // whose id appears in the catalog keep their rich UX (steps, keyPlaceholder,
  // free tier badge). Catalog-only entries get a generic card with console_url.
  const curatedIds = new Set(CURATED_PROVIDERS.map((p) => p.id));
  const visibleCurated = catalogLoaded
    ? CURATED_PROVIDERS.filter((p) => catalogEntries.some((c) => c.id === p.id))
    : CURATED_PROVIDERS; // offline fallback: show all curated
  const genericOnly = catalogLoaded
    ? catalogEntries.filter((c) => !curatedIds.has(c.id))
    : [];

  const def = visibleCurated.find((p) => p.id === selected) ?? null;

  return (
    <div className="rounded-lg border border-border-subtle bg-bg-primary/40 p-4 space-y-4">
      <div className="grid grid-cols-2 gap-2">
        {visibleCurated.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setSelected(p.id)}
            className={cn(
              'flex items-center justify-between px-3 py-2 rounded-lg border text-sm transition-colors',
              selected === p.id ? 'border-brand bg-brand/10 text-text-primary' : 'border-border-subtle text-text-secondary hover:bg-bg-hover',
            )}
          >
            <span>{p.name}</span>
            {p.free && <span className="text-micro px-1.5 py-0.5 rounded-full bg-success/15 text-success shrink-0">free tier</span>}
          </button>
        ))}
        {genericOnly.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setSelected(c.id)}
            className={cn(
              'flex items-center justify-between px-3 py-2 rounded-lg border text-sm transition-colors',
              selected === c.id ? 'border-brand bg-brand/10 text-text-primary' : 'border-border-subtle text-text-secondary hover:bg-bg-hover',
            )}
          >
            <span>{c.name}</span>
            {c.free_tier_note && <span className="text-micro px-1.5 py-0.5 rounded-full bg-success/15 text-success shrink-0">free tier</span>}
          </button>
        ))}
      </div>

      {def && <CloudProviderForm def={def} />}

      {!def && selected && (() => {
        const generic = genericOnly.find((c) => c.id === selected);
        if (!generic) return null;
        return (
          <div className="space-y-2 pt-1">
            {generic.free_tier_note && <p className="text-xs text-success">{generic.free_tier_note}</p>}
            {generic.console_url && (
              <a
                href={generic.console_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-brand hover:underline"
              >
                <ExternalLink size={12} /> Open {generic.name} console
              </a>
            )}
            <p className="text-xs text-text-muted">Add your API key in Models → Cloud after the wizard.</p>
          </div>
        );
      })()}

      <button
        type="button"
        onClick={() => { defer(); navigate('/models?tab=cloud'); }}
        className="flex items-center gap-1 text-xs text-text-muted hover:text-text-primary transition-colors"
      >
        More providers in Models → Cloud <ChevronRight size={12} />
      </button>
    </div>
  );
}

function CloudProviderForm({ def }: { def: typeof CURATED_PROVIDERS[number] }) {
  const saveByokProvider = useSettings((s) => s.saveByokProvider);
  const testByokProvider = useSettings((s) => s.testByokProvider);
  const [apiKey, setApiKey] = useState('');
  // A pasted key is unreadable behind dots, so the one mistake this screen
  // cannot recover from — pasting the wrong thing, or half of it — is also
  // the one the user cannot see. Off by default; the reveal is theirs to ask
  // for.
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Trimmed at both call sites. Copying a key out of a browser or a password
  // manager routinely picks up trailing whitespace, and a key stored with a
  // newline in it goes onto the wire inside the Authorization header — which
  // the provider answers with a 401. The user then re-pastes the same correct
  // key, gets the same error, and nothing suggests whitespace is the problem.
  const handleTest = async () => {
    const key = apiKey.trim();
    if (!key) { setMsg({ ok: false, text: 'Paste the key first' }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await testByokProvider({ providerId: def.id, apiKey: key, baseUrl: null });
      setMsg(r.ok ? { ok: true, text: '✓ Connected' } : { ok: false, text: r.error ?? 'Connection failed' });
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally { setBusy(false); }
  };

  const handleSave = async () => {
    const key = apiKey.trim();
    if (!key) { setMsg({ ok: false, text: 'Paste the key first' }); return; }
    setBusy(true); setMsg(null);
    try {
      await saveByokProvider({ providerId: def.id, enabled: true, apiKey: key, baseUrl: null, defaultModel: null });
      // The provider just configured is the one that answers, in both modes,
      // from the very next message. Saving alone left `cloudModel` empty and
      // the sidecar on its old route, so the first thing a new person typed
      // after pasting a working key was answered with "no model" (Astra,
      // 19 Sep 2026, P1). Rust filled the catalogue's default model on save.
      const modelId = useSettings.getState().byok.find((p) => p.id === def.id)?.default_model ?? null;
      const picked = pointChatAt(def.id, def.name, modelId);
      setMsg({ ok: true, text: picked ? `✓ ${def.name} saved, ${picked} will answer` : `✓ ${def.name} saved` });
    } catch (e) {
      // Surface the Rust error verbatim — bare `catch {}` swallowed the real
      // reason (keychain locked, disk full, permission denied on
      // ~/.cinderpaw/byok.json). The wizard is often a user's first save attempt,
      // so a helpful reason here saves the whole session.
      const reason = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      setMsg({ ok: false, text: `Save failed: ${reason}` });
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3 pt-1">
      <ol className="space-y-1.5 text-xs text-text-muted list-decimal list-inside">
        {def.steps.map((s, i) => <li key={i}>{s}</li>)}
      </ol>
      <p className={cn('text-xs', def.free ? 'text-success' : 'text-warning')}>{def.note}</p>
      <a
        href={def.console}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1.5 text-xs text-brand hover:underline"
      >
        <ExternalLink size={12} /> Open {def.name} console
      </a>

      <div className="relative">
        <input
          type={showKey ? 'text' : 'password'}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={def.keyPlaceholder}
          className="w-full pl-3 pr-10 py-2 rounded-lg border border-border-default bg-bg-primary text-sm text-text-primary font-mono placeholder:text-text-muted/50 focus:outline-hidden focus:ring-2 focus:ring-brand/50"
          aria-label={`${def.name} API key`}
        />
        <button
          type="button"
          onClick={() => setShowKey((v) => !v)}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-primary transition-colors"
          aria-label={showKey ? 'Hide the key' : 'Show the key'}
          aria-pressed={showKey}
        >
          {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleTest()}
          disabled={busy || !apiKey}
          className={SECONDARY_BUTTON}
        >
          Test
        </button>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={busy || !apiKey}
          className="px-3 py-1.5 rounded-md bg-brand text-on-brand text-sm font-medium hover:bg-brand/90 transition-colors disabled:opacity-50"
        >
          Save
        </button>
        {msg && <span className={cn('text-xs', msg.ok ? 'text-success' : 'text-error')}>{msg.text}</span>}
      </div>
    </div>
  );
}

// ── Step 5: Done ────────────────────────────────────────────────────────────

function DoneStep() {
  // The ticks say what is true, not what the board drew: a person who skipped
  // the model step sees it unticked and where to finish it, instead of a
  // "Model selected" that leaves the first message answered with "no model".
  const cloudModel = useModel((s) => s.cloudModel);
  const loaded = useModel((s) => s.loaded);
  const downloaded = useDownload((s) => s.done);
  const byok = useSettings((s) => s.byok);
  const hasModel = !!cloudModel || !!loaded || downloaded || byok.some((p) => p.enabled && p.has_api_key);
  const [hasTools, setHasTools] = useState(false);
  useEffect(() => {
    let alive = true;
    void Promise.all([
      tauri.mcp.list().catch(() => []),
      tauri.connectors.list().catch(() => []),
    ]).then(([tools, chats]) => {
      if (alive) setHasTools(tools.length > 0 || chats.some((c) => c.enabled));
    });
    return () => { alive = false; };
  }, []);

  const ticks: [boolean, string, string][] = [
    [hasModel, 'Model selected', 'Pick a model in Models'],
    [hasTools, 'Tools connected', 'Connect apps in Settings'],
    [true, 'Workspace ready', ''],
  ];

  return (
    <div>
      <StepIntro
        title={<>You’re ready<br />to explore</>}
        lead="Your adaptive workspace is set up."
        body="Start a conversation, build an artifact, or let Cinderpaw help with research, writing, and automation."
      />
      <FeatureCards
        items={[
          { icon: Search, title: 'Research', line: 'Find, summarize, and explore information.' },
          { icon: PenLine, title: 'Create', line: 'Write, design, and build artifacts.' },
          { icon: BarChart3, title: 'Analyze', line: 'Make sense of data and find insights.' },
          { icon: Settings, title: 'Automate', line: 'Turn ideas into actions with powerful tools.' },
        ]}
      />
      <ul className="mt-6 flex flex-wrap gap-x-6 gap-y-2">
        {ticks.map(([ok, label, todo]) => (
          <li key={label} className="flex items-center gap-2 text-sm">
            <span className={cn('flex size-6 items-center justify-center rounded-full', ok ? 'bg-brand text-on-brand' : 'bg-bg-hover text-text-muted')}>
              <Check size={14} />
            </span>
            <span className={ok ? 'text-text-primary' : 'text-text-muted'}>{ok ? label : todo}</span>
          </li>
        ))}
      </ul>
      <div className="mt-6 space-y-3">
        <DiskEncryptionNotice />
        <InstallCountNotice />
      </div>
    </div>
  );
}

/**
 * The one thing Cinderpaw ever sends about itself, said before it is sent.
 *
 * The count exists because the GitHub download number is not an install
 * number: v2026.08.11 read 519, of which 449 were the updater fetching
 * `latest.json` from installs we already had. About 60 were real.
 *
 * The rules this notice has to keep, and the reason it lives HERE rather than
 * in Settings: nothing is sent until the person has read this, so it sits on
 * the screen they are on when the ping fires, with the switch beside it. An
 * opt-out you find the day after is not an opt-out. The full contents are
 * spelled out because "anonymous usage data" is what everybody writes and
 * nobody believes.
 */
function InstallCountNotice() {
  const on = useOnboarding((s) => s.countInstall);
  const setOn = useOnboarding((s) => s.setCountInstall);
  return (
    <label className="flex items-start gap-3 text-left mx-auto max-w-md rounded-xl border border-border-subtle bg-bg-primary/50 px-4 py-3 cursor-pointer">
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => setOn(e.target.checked)}
        className="mt-0.5 size-4 accent-brand"
      />
      <span className="text-xs text-text-muted leading-relaxed">
        <span className="text-text-primary font-medium">Count this install, once.</span>{' '}
        When you open chat, Cinderpaw sends one message containing its version
        number and your operating system, nothing else, never again, and
        nothing about you or what you do here. It is how we know how many
        people actually run it. Untick and nothing is sent at all. Either way,{' '}
        <code className="text-micro">~/.cinderpaw/.install-counted</code> is
        written with exactly what happened, so you can check.
      </span>
    </label>
  );
}

/**
 * At-rest data protection notice (H-1). Cinderpaw keeps everything local, so the
 * confidentiality of conversations and memory on disk depends on the OS's
 * full-disk encryption. We surface the host's status here — reassurance when
 * it's on, a clear nudge when it isn't. Silent on any error (e.g. running
 * outside the desktop shell) so it never blocks finishing onboarding.
 */
function DiskEncryptionNotice() {
  const [status, setStatus] = useState<DiskEncryptionStatus | null>(null);
  useEffect(() => {
    void tauri.system
      .diskEncryption()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);
  if (!status) return null;

  const variant = {
    on: {
      Icon: ShieldCheck,
      accent: 'text-success',
      ring: 'border-success/30 bg-success/5',
      title: 'Your data is protected at rest',
      body: 'Disk encryption is on, so your conversations and memory are safe even if this device is lost.',
    },
    off: {
      Icon: ShieldAlert,
      accent: 'text-warning',
      ring: 'border-warning/30 bg-warning/5',
      title: 'Turn on disk encryption',
      body: 'Your data lives only on this device. Enable BitLocker (Windows) or FileVault (macOS) so it stays private if the device is lost or stolen.',
    },
    unknown: {
      Icon: Shield,
      accent: 'text-text-muted',
      ring: 'border-border-subtle bg-bg-primary/50',
      title: 'Check your disk encryption',
      body: 'We could not verify it automatically. Make sure BitLocker (Windows) or FileVault (macOS) is on to protect your data at rest.',
    },
  }[status.state];

  return (
    <div
      className={cn(
        'mx-auto max-w-md text-left rounded-lg border p-4 flex gap-3',
        variant.ring,
      )}
    >
      <variant.Icon size={20} className={cn('shrink-0 mt-0.5', variant.accent)} />
      <div className="space-y-1">
        <p className="text-sm font-medium text-text-primary">{variant.title}</p>
        <p className="text-xs text-text-muted leading-relaxed">{variant.body}</p>
      </div>
    </div>
  );
}

// ── Onboarding orchestrator (mounts the wizard) ─────────────────────────────

/**
 * Mount this once in the app shell. On mount it loads the persisted
 * record; if none exists (or `completed === false`), it shows the
 * wizard. The user can dismiss it with Skip or finish it to write
 * the record to disk.
 */
export function OnboardingOrchestrator() {
  const loadPersisted = useOnboarding((s) => s.loadPersisted);
  const start = useOnboarding((s) => s.start);
  const hasOnboardedBefore = useOnboarding((s) => s.hasOnboardedBefore);
  const active = useOnboarding((s) => s.active);
  const persistFailed = useOnboarding((s) => s.persistFailed);
  const [checked, setChecked] = useState(false);

  /*
    Neither storage layer took the record. Before this, that was two
    `console.warn` lines in devtools nobody has open: the wizard closed as if it
    had worked, the name the person chose was gone, and it reopened on the next
    launch, and the one after that, with nothing anywhere saying why. The
    condition is rare and the consequence is a loop the person cannot get out
    of, which is exactly the kind of thing that has to be on their screen.
  */
  useEffect(() => {
    if (!persistFailed) return;
    useNotifications.getState().push(
      'error',
      'Your setup could not be saved',
      'Cinderpaw could not write to its folder in your home directory, so it ' +
        'will ask you these questions again next time it starts. Check that ' +
        'the disk is not full and that Cinderpaw is allowed to write there.',
    );
  }, [persistFailed]);

  useEffect(() => {
    void (async () => {
      const alreadyDone = await loadPersisted();
      if (!alreadyDone) {
        // First run — show the wizard after a brief tick so the app shell
        // has time to paint underneath (avoids a white flash).
        setTimeout(() => start(), 300);
      }
      setChecked(true);
    })();
  }, [loadPersisted, start]);

  // Don't render the wizard until the persisted check is done — otherwise
  // a returning user briefly sees the wizard while loadPersisted is in flight.
  if (!checked) return null;
  // Hide for returning users UNLESS the wizard was explicitly reopened (e.g.
  // "Re-run welcome" button in Settings → General calls reopen()).
  if (hasOnboardedBefore && !active) return null;

  return <OnboardingWizard />;
}
