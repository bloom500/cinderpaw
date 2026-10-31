/**
 * OnboardingWizard — first-run experience, three cards (31 Oct 2026, Darius's
 * release gate: someone who saw the promo film starts with no effort, "almost
 * Apple intuitive").
 *
 *   1. Welcome   — what Cinderpaw does, as a film ("Your AI team"), then Get started
 *   2. Provider  — a brain: one free sign-in, or a key, or a model on this computer
 *   3. Done      — the names, the notices, and a first task that lands in the chat
 *
 * Connections and the workspace tour left the wizard: a stranger meets them
 * where they are used, not as two more screens before the first answer.
 * Both names are injected into the agent's system prompt as a USER block.
 *
 * Skippable. If the user dismisses, defaults are used and they can
 * re-open the wizard from Settings later.
 */

import { useEffect, useRef, useState, Fragment, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowRight, ArrowLeft, CalendarCheck, Check, ChevronRight, Download, ExternalLink, Eye, EyeOff, KeyRound, Laptop, Loader2, Maximize2, Megaphone, MessageCircle, Search, Shield, ShieldAlert, ShieldCheck, Sparkles, Volume2, VolumeX, X, type LucideIcon } from 'lucide-react';
import { STEP_IDS, useOnboarding } from '@/stores/onboarding';
import { useSystemInfo } from '@/stores/systemInfo';
import { useDownload } from '@/stores/download';
import { useSettings } from '@/stores/settings';
import { useModel } from '@/stores/model';
import { useCinderpawStore } from '@/stores/cinderpaw';
import { useCatalog } from '@/stores/catalog';
import { useNotifications } from '@/stores/notifications';
import { recommendModel } from '@/lib/hardwareRecommendation';
import { tauri, type DiskEncryptionStatus, type SetupCandidate, type SetupVerifyOutcome } from '@/lib/tauri';
import { signInWithOpenRouter } from '@/lib/openrouterSignIn';
import { CinderpawMascot, usePrefersReducedMotion } from '@/components/chat/mascot/CinderpawMascot';
import { ModelLogo } from '@/lib/modelLogos';
import { ImportCard } from './ImportCard';
import { WhatIsSent } from '@/components/usage/WhatIsSent';
import { cn, SECONDARY_BUTTON } from '@/lib/utils';
import { ListenButton } from '@/components/voice/ListenButton';
import type { CubbyLineId } from '@/voice/cubby-lines';
import { BASE } from '@/lib/motion';
import { useAttention } from '@/lib/attention';
import filmWebm from '@/assets/onboarding/your-ai-team.webm';
import filmMp4 from '@/assets/onboarding/your-ai-team.mp4';
import filmPoster from '@/assets/onboarding/your-ai-team-poster.webp';

const stepVariants = {
  enter: { opacity: 0, y: 12 },
  center: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -12 },
};

const PRIMARY_BUTTON =
  'inline-flex items-center gap-2.5 rounded-2xl bg-brand px-7 py-3.5 text-base font-medium text-on-brand shadow-lg shadow-brand/25 transition-colors hover:bg-brand/90 disabled:cursor-not-allowed disabled:bg-bg-hover disabled:text-text-muted disabled:shadow-none';

/**
 * Something will answer the first message: a model picked or loaded, a key
 * saved, a download done or on its way, or a brain found on this machine that
 * passed a real completion. The brain card's Continue waits for this, so a
 * stranger cannot click through to a chat that answers "no model".
 */
function useBrainReady(): boolean {
  const cloudModel = useModel((s) => s.cloudModel);
  const loaded = useModel((s) => s.loaded);
  const downloading = useDownload((s) => !!s.active);
  const downloaded = useDownload((s) => s.done);
  const byok = useSettings((s) => s.byok);
  const verified = useOnboarding((s) => s.brainVerified);
  return !!cloudModel || !!loaded || downloaded || downloading || verified || byok.some((p) => p.enabled && p.has_api_key);
}

export function OnboardingWizard() {
  const navigate = useNavigate();
  const active = useOnboarding((s) => s.active);
  const step = useOnboarding((s) => s.step);
  const totalSteps = useOnboarding((s) => s.totalSteps);
  const prev = useOnboarding((s) => s.prev);
  const next = useOnboarding((s) => s.next);
  const skip = useOnboarding((s) => s.skip);
  const finish = useOnboarding((s) => s.finish);
  const brainReady = useBrainReady();

  if (!active) return null;
  const isFirst = step === 0;
  const isLast = step === totalSteps - 1;
  const onBrain = STEP_IDS[step] === 'provider';

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-bg-primary"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
    >
      {/* This overlay covers the shell's drag strip; the window needs its own. */}
      <div data-tauri-drag-region aria-hidden className="fixed top-0 inset-x-0 h-8" />
      <div className="mx-auto flex min-h-full max-w-6xl flex-col px-4 py-6 sm:px-10 sm:py-8">
        <header className="flex items-center gap-2" aria-hidden>
          <CinderpawMascot state="idle" width={32} />
          <span className="font-display text-xl text-text-primary">Cinderpaw</span>
        </header>

        {/* One column: the film, the choices and the first tasks each need the
            whole width; a mascot beside them squeezed the tasks into a strip. */}
        <div className="grid flex-1 items-center gap-10 py-6">
          <div className="min-w-0">
            <StepCounter step={step} total={totalSteps} />
            <AnimatePresence mode="wait">
              <motion.div
                key={step}
                variants={stepVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={BASE}
                className="mt-6"
              >
                {step === 0 && <WelcomeStep />}
                {step === 1 && <ProviderStep />}
                {step === 2 && <DoneStep />}
              </motion.div>
            </AnimatePresence>

            {/* Pinned to the bottom of the window: on an 800 px screen the last
                board pushed "Start exploring" below the fold (UX lab, item 8). */}
            <nav className="sticky bottom-0 z-10 mt-8 flex flex-wrap items-center gap-4 bg-bg-primary py-4">
              {!isFirst && (
                // inline-flex: the shared button is a block, and the arrow sat
                // on a line of its own above "Back".
                <button type="button" onClick={prev} className={cn(SECONDARY_BUTTON, 'inline-flex items-center gap-2 rounded-2xl px-5 py-3 text-base')}>
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
                  // With nothing to answer, "Choose a model" is the one orange action on the card.
                  className={brainReady ? PRIMARY_BUTTON : cn(SECONDARY_BUTTON, 'inline-flex items-center gap-2 rounded-2xl px-5 py-3 text-base')}
                >
                  Start exploring <ArrowRight size={16} />
                </button>
              ) : (
                <button type="button" onClick={next} disabled={onBrain && !brainReady} className={PRIMARY_BUTTON}>
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
              {/* A Continue that does nothing must say why on the screen, and
                  leave a way on: skipping is the person's call, said out loud. */}
              {onBrain && !brainReady && (
                <span className="text-sm text-text-muted">
                  Pick one way above so I can answer you, or{' '}
                  <button type="button" onClick={next} className="underline underline-offset-4 hover:text-text-primary">skip for now</button>.
                </span>
              )}
            </nav>
          </div>

        </div>
      </div>
    </div>
  );
}

function StepCounter({ step, total }: { step: number; total: number }) {
  return (
    <div className="flex items-center gap-5" aria-label={`Installed. Step ${step + 1} of ${total}`}>
      <span className="text-xs font-medium text-text-muted">{step + 1} of {total}</span>
      <span className="flex items-center" aria-hidden>
        {/* Never at zero (27 Oct): the install is a step the person already did,
            so the path starts with it ticked rather than with empty dots. */}
        <span className="flex items-center gap-1 text-xs font-medium text-brand">
          <Check size={12} /> Installed
        </span>
        <span className="h-px w-5 bg-brand/50" />
        {Array.from({ length: total }, (_, i) => (
          <Fragment key={i}>
            {i > 0 && <span className={cn('h-px w-5', i <= step ? 'bg-brand/50' : 'bg-border-default')} />}
            <span
              className={cn(
                'rounded-full transition-all duration-(--motion-slow)',
                i === step ? 'size-3.5 bg-brand' : i < step ? 'size-2 bg-brand/50' : 'size-2 bg-border-default',
              )}
            />
          </Fragment>
        ))}
      </span>
    </div>
  );
}

/** A board's title, its serif lead line, and the plain sentence under it. With
 *  `voice`, a Listen button beside the title plays Cubby's spoken version. */
export function StepIntro({ title, lead, body, voice }: { title: ReactNode; lead: string; body: string; voice?: CubbyLineId }) {
  return (
    <div>
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <h1 id="onboarding-title" className="font-display text-4xl leading-[1.02] tracking-tight text-text-primary sm:text-5xl [@media(min-height:900px)]:sm:text-6xl">
          {title}
        </h1>
        {voice && <ListenButton line={voice} />}
      </div>
      <p className="mt-3 font-display text-xl leading-snug text-text-primary sm:text-2xl [@media(min-height:900px)]:sm:text-3xl">{lead}</p>
      <p className="mt-2 max-w-xl text-base leading-relaxed text-text-muted [@media(min-height:900px)]:text-lg">{body}</p>
    </div>
  );
}

// ── Step 1: Welcome ─────────────────────────────────────────────────────────

function WelcomeStep() {
  return (
    <div>
      <div className="grid items-center gap-8 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
        <StepIntro
          voice="onboarding.welcome"
          title={<>Your AI<br />team</>}
          lead="For you, and for your business."
          body="It makes your posts, answers your customers, compares prices and books a table. It always asks before it posts, pays or books."
        />
        <TeamFilm />
      </div>
      <ImportCard />
    </div>
  );
}

/**
 * The "Your AI team" film (videos/your-ai-team): one day in Ana's flower shop,
 * the four jobs, 37 s. It starts without sound: a webview starts a video on its
 * own only when it is muted, and nobody opening an app for the first time
 * should meet music they did not ask for. One button turns the music on and
 * plays it from the start. With reduced motion nothing plays until asked.
 * WebM first (Linux webviews ship VP9 more often than H.264), MP4 for the rest,
 * and the poster stays if neither can play. Full screen opens it over the
 * whole screen (Darius, 31 Oct), from where it was.
 */
function TeamFilm() {
  const still = usePrefersReducedMotion();
  const ref = useRef<HTMLVideoElement>(null);
  const [sound, setSound] = useState(false);
  const [big, setBig] = useState<number | null>(null);
  const openBig = () => {
    const v = ref.current;
    v?.pause();
    setBig(v?.currentTime ?? 0);
  };
  const closeBig = (at: number) => {
    setBig(null);
    const v = ref.current;
    if (!v) return;
    v.currentTime = at;
    if (!still) void v.play()?.catch(() => {});
  };
  useEffect(() => {
    const v = ref.current;
    if (!v || still) return;
    // The property, not only the attribute, is what the autoplay rule reads.
    v.muted = true;
    void v.play()?.catch(() => {});
  }, [still]);
  const toggleSound = () => {
    const v = ref.current;
    if (!v) return;
    v.muted = sound;
    if (!sound) {
      v.currentTime = 0;
      void v.play()?.catch(() => {});
    }
    setSound(!sound);
  };
  return (
    <div className="relative">
      <video
        ref={ref}
        className="aspect-video w-full rounded-2xl bg-bg-surface object-cover shadow-xl"
        poster={filmPoster}
        autoPlay={!still}
        muted
        loop
        playsInline
        controls={still}
        preload="auto"
        aria-label="A short film: one day in Ana's flower shop. Cinderpaw makes her post, compares prices, answers a customer after closing and books a table, asking her before it posts or books."
      >
        <source src={filmWebm} type="video/webm" />
        <source src={filmMp4} type="video/mp4" />
      </video>
      {!still && (
        <button
          type="button"
          onClick={toggleSound}
          aria-pressed={sound}
          className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1.5 text-sm text-white transition-colors hover:bg-black/75"
        >
          {sound ? <Volume2 size={16} /> : <VolumeX size={16} />} {sound ? 'Sound off' : 'Sound on'}
        </button>
      )}
      <button
        type="button"
        onClick={openBig}
        className="absolute bottom-3 left-3 inline-flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1.5 text-sm text-white transition-colors hover:bg-black/75"
      >
        <Maximize2 size={16} /> Full screen
      </button>
      {big !== null && <FilmFullScreen from={big} sound={sound} onClose={closeBig} />}
    </div>
  );
}

/**
 * The film over the whole screen. Drawn over everything on the page itself,
 * not through the browser's fullscreen API, which webviews support unevenly
 * (macOS needs a setting the app does not control); the window goes full
 * screen too when it was not already, and comes back on close. Esc closes,
 * like every full-screen video.
 */
/** Whether the film put the window in full screen, so closing it gives back only
 *  what it took. Module-wide: React's dev double-mount must not lose it. */
let filmMadeWindowFull = false;

function FilmFullScreen({ from, sound, onClose }: { from: number; sound: boolean; onClose: (at: number) => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const close = () => onClose(ref.current?.currentTime ?? from);
  useEffect(() => {
    const v = ref.current;
    if (v) {
      v.currentTime = from;
      v.muted = !sound;
      void v.play()?.catch(() => {});
    }
    void (async () => {
      try {
        const win = getCurrentWindow();
        if (!(await win.isFullscreen())) { await win.setFullscreen(true); filmMadeWindowFull = true; }
      } catch { /* not inside the app (a browser preview): the page is the whole screen */ }
    })();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (filmMadeWindowFull) {
        filmMadeWindowFull = false;
        try { void getCurrentWindow().setFullscreen(false).catch(() => {}); } catch { /* not inside the app */ }
      }
    };
    // Opened once per click; `close` only reads the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return createPortal(
    <div role="dialog" aria-label="Your AI team, full screen" className="fixed inset-0 z-[300] flex items-center justify-center bg-black">
      <video ref={ref} className="h-full w-full object-contain" poster={filmPoster} controls playsInline loop>
        <source src={filmWebm} type="video/webm" />
        <source src={filmMp4} type="video/mp4" />
      </video>
      <button
        type="button"
        onClick={close}
        className="absolute right-4 top-4 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-sm text-white transition-colors hover:bg-white/25"
      >
        <X size={16} /> Close
      </button>
    </div>,
    document.body,
  );
}

// ── Step 2: Provider — "Pick my brain" ─────────────────────────────────────

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
    note: 'Starts on OpenRouter\'s free models, no credit card needed. Free use is capped at 50 requests a day.',
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
  const sysInfo = useSystemInfo((s) => s.info);
  const fetchSysInfo = useSystemInfo((s) => s.fetch);
  useEffect(() => { void fetchSysInfo(); }, [fetchSysInfo]);
  // Cinderpaw's tools fumble on anything under ~27B and most machines cannot
  // run 27B, so "this computer" is only called a good start where it fits.
  const localFits = recommendModel(sysInfo)?.sizeClass === '13–14B';
  const [other, setOther] = useState<'key' | 'local' | null>(null);
  const signedIn = useModel((s) => s.cloudModel?.providerId === 'openrouter');
  const [busy, setBusy] = useState(false);

  return (
    <div>
      <div className="flex items-start justify-between gap-6">
        <StepIntro
          voice="onboarding.provider"
          title="Pick my brain"
          lead="The brain is the AI model that thinks and writes for me."
          body="The easiest way is free and works on any computer. You can change it anytime in Models."
        />
        <span className="hidden shrink-0 sm:block" aria-hidden><CinderpawMascot state="curious" width={150} /></span>
      </div>

      <div className="mt-6"><DetectedSection /></div>

      {/* One button that works on any computer: OpenRouter's sign-in opens the
          browser, and the free model it pins answers without a card or a key
          to copy. The host says how it went in a toast either way. */}
      <button
        type="button"
        disabled={busy || signedIn}
        onClick={() => { setBusy(true); void signInWithOpenRouter().finally(() => setBusy(false)); }}
        className="mt-6 flex w-full items-center gap-4 rounded-2xl border-2 border-brand bg-brand/10 p-5 text-left transition-colors hover:bg-brand/15 disabled:cursor-default"
      >
        <ModelLogo provider="openrouter" className="size-10 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block text-lg font-medium text-text-primary">
            {signedIn ? 'Signed in with OpenRouter' : busy ? 'Finish in your browser…' : 'Sign in with OpenRouter'}
          </span>
          <span className="block text-sm text-text-muted">
            {signedIn ? 'I am ready to answer. Press Continue.' : 'Free, with a daily limit. Works on any computer. Sign in with Google or email.'}
          </span>
        </span>
        {signedIn ? <Check size={20} className="shrink-0 text-brand" /> : busy ? <Loader2 size={20} className="shrink-0 animate-spin text-brand" /> : <ArrowRight size={20} className="shrink-0 text-brand" />}
      </button>

      <p className="mt-5 text-sm font-medium text-text-secondary">Or</p>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <ForkCard
          icon={<KeyRound size={28} className="text-text-secondary" />}
          title="I have a key"
          subtitle="OpenAI, Claude, Gemini and more."
          selected={other === 'key'}
          onClick={() => setOther((o) => (o === 'key' ? null : 'key'))}
        />
        <ForkCard
          icon={<Laptop size={28} className="text-text-secondary" />}
          title="This computer"
          subtitle={localFits ? 'Free and private. Your computer is strong enough.' : 'Free and private. Needs a strong computer.'}
          selected={other === 'local'}
          onClick={() => setOther((o) => (o === 'local' ? null : 'local'))}
        />
      </div>

      <div className="mt-4">
        {other === 'key' && <CloudBranch />}
        {other === 'local' && <LocalBranch />}
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
      // The brain card's Continue waits for an answer it can trust; a key found
      // here also lands in the key list it reads.
      if (outcome.ok) {
        useOnboarding.setState({ brainVerified: true });
        void useSettings.getState().fetchByok();
      }
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
  // A failed catalog load also ends `loaded` with an empty list; filtering by
  // it then showed "I have a key" with nothing under it.
  const visibleCurated = catalogLoaded && catalogEntries.length > 0
    ? CURATED_PROVIDERS.filter((p) => catalogEntries.some((c) => c.id === p.id))
    : CURATED_PROVIDERS; // offline fallback: show all curated
  // Hugging Face has its own card above; listed here too it read as two things.
  const genericOnly = catalogLoaded
    ? catalogEntries.filter((c) => !curatedIds.has(c.id) && c.id !== 'huggingface')
    : [];

  const def = visibleCurated.find((p) => p.id === selected) ?? null;
  // Four on the board; the rest only when the person asks for them, so the
  // page grows (and scrolls) only by their own click.
  const [more, setMore] = useState(false);
  const tile = (on: boolean) => cn(
    'flex min-w-0 items-center gap-2 rounded-xl border px-3 py-2.5 text-sm transition-colors',
    on ? 'border-brand bg-brand/10 text-text-primary' : 'border-border-default bg-bg-surface text-text-secondary hover:bg-bg-hover',
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {visibleCurated.slice(0, 4).map((p) => (
          <button key={p.id} type="button" onClick={() => setSelected(p.id)} className={tile(selected === p.id)}>
            <ModelLogo provider={p.id} className="size-5 shrink-0" />
            <span className="truncate">{p.name}</span>
            {p.free && <span className="ml-auto shrink-0 rounded-full bg-success/15 px-1.5 py-0.5 text-micro text-success">free</span>}
          </button>
        ))}
        {genericOnly.length > 0 && (
          <button type="button" onClick={() => setMore((m) => !m)} aria-expanded={more} className={tile(false)}>
            <span className="truncate">{more ? 'Show less' : 'View more'}</span>
            <ChevronRight size={14} className={cn('ml-auto shrink-0 transition-transform', more && 'rotate-90')} />
          </button>
        )}
        {more && genericOnly.map((c) => (
          <button key={c.id} type="button" onClick={() => setSelected(c.id)} className={tile(selected === c.id)}>
            <ModelLogo provider={c.id} className="size-5 shrink-0" />
            <span className="truncate">{c.name}</span>
            {c.free_tier_note && <span className="ml-auto shrink-0 rounded-full bg-success/15 px-1.5 py-0.5 text-micro text-success">free</span>}
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

// ── Step 3: Done ────────────────────────────────────────────────────────────

/** The film's four jobs, as first tasks. Each fills the chat box and stops
 *  there (the Home intents' rule): the person reads it and presses Enter. */
const FIRST_TASKS: { icon: LucideIcon; team: string; task: string }[] = [
  { icon: Megaphone, team: 'Marketing', task: "Make a poster and a short post for my shop's weekend sale" },
  { icon: Search, team: 'Research', task: 'Find the five best-reviewed coffee machines and put them in a table' },
  { icon: MessageCircle, team: 'Customers', task: "Help me answer my shop's customers on WhatsApp" },
  { icon: CalendarCheck, team: 'Personal', task: 'Plan a weekend trip for two: where to go, how to get there and what it costs' },
];

const NAME_INPUT =
  'mt-1.5 w-full rounded-xl border border-border-default bg-bg-surface px-3.5 py-2.5 text-base text-text-primary placeholder:text-text-muted/60 focus:border-brand focus:outline-hidden focus:ring-2 focus:ring-brand/40';

function DoneStep() {
  const navigate = useNavigate();
  const ready = useBrainReady();
  const downloading = useDownload((s) => !!s.active && !s.done);
  const finish = useOnboarding((s) => s.finish);
  const setFirstTask = useOnboarding((s) => s.setFirstTask);
  const userName = useOnboarding((s) => s.userName);
  const setUserName = useOnboarding((s) => s.setUserName);
  const agentName = useOnboarding((s) => s.agentName);
  const setAgentName = useOnboarding((s) => s.setAgentName);
  const begin = (task: string) => { setFirstTask(task); navigate('/chat'); void finish(); };

  return (
    <div>
      {/* With no model nothing can answer, so it does not say "ready" (UX lab,
          item 2: confetti here, then "No model is chosen yet" on the first message). */}
      {ready ? (
        <StepIntro
          voice="onboarding.done"
          title={<>What should<br />we do first?</>}
          lead="Pick a job, or ask me anything."
          body="It goes in the chat box. Nothing is sent until you press Enter."
        />
      ) : (
        <div>
          <StepIntro
            title={<>Almost<br />ready</>}
            lead="Pick a model so I can answer you."
            body="A model is the brain that writes the answers. Without one, I cannot reply yet. It takes a minute."
          />
          <button type="button" onClick={() => useOnboarding.setState({ step: STEP_IDS.indexOf('provider') })} className={cn(PRIMARY_BUTTON, 'mt-5')}>
            Choose a model <ArrowRight size={16} />
          </button>
        </div>
      )}
      {downloading && (
        <p className="mt-3 flex items-center gap-2 text-sm text-text-muted">
          <Loader2 size={14} className="animate-spin" /> Your model is still downloading. I can answer as soon as it is done.
        </p>
      )}

      {/* 27 Oct: names are optional. A forced field is a decision the person
          must make before anything happens (Settings already allows none). */}
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-sm font-medium text-text-secondary">Your name (optional)</span>
          <input type="text" value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="e.g. Ana" maxLength={40} className={NAME_INPUT} />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-text-secondary">My name</span>
          <input type="text" value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="Cinderpaw" maxLength={40} className={NAME_INPUT} />
        </label>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        {FIRST_TASKS.map(({ icon: Icon, team, task }) => (
          <button
            key={team}
            type="button"
            onClick={() => begin(task)}
            className="flex items-start gap-3 rounded-xl border border-border-subtle bg-bg-surface p-4 text-left transition-colors hover:border-brand/50 hover:bg-bg-hover"
          >
            <Icon size={20} className="mt-0.5 shrink-0 text-brand" />
            <span>
              <span className="block text-sm font-medium text-text-secondary">{team}</span>
              <span className="block text-base text-text-primary">{task}</span>
            </span>
          </button>
        ))}
      </div>

      {/* Alpha, said once, here: it used to be a card that came back every
          week over whatever the person was doing (Darius, 20 Oct). One quiet
          line, not another box: this screen already has enough of them. */}
      <p className="mt-6 text-xs leading-relaxed text-text-muted">
        Cinderpaw is still in alpha, so some things may change or break between updates.
        If something goes wrong, Settings, About, Report a bug helps us fix it.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <DiskEncryptionNotice />
        <InstallCountNotice />
        <ShareUsageNotice />
        <HeardFromQuestion />
      </div>
    </div>
  );
}

/** The buttons' words, in the order shown. The host and the worker accept only these ids. */
const HEARD_FROM: [string, string][] = [
  ['reddit', 'Reddit'], ['youtube', 'YouTube'], ['github', 'GitHub'], ['discord', 'Discord'], ['instagram', 'Instagram'],
  ['tiktok', 'TikTok'], ['x', 'X'], ['hackernews', 'Hacker News'], ['friend', 'A friend'], ['other', 'Somewhere else'],
];

/**
 * Where the person heard about Cinderpaw: optional, nothing picked for them,
 * sent once with the install count and only while that box is ticked. A
 * button, never a text box, so the ping cannot carry anything they typed.
 */
function HeardFromQuestion() {
  const counting = useOnboarding((s) => s.countInstall);
  const picked = useOnboarding((s) => s.heardFrom);
  const setPicked = useOnboarding((s) => s.setHeardFrom);
  if (!counting) return null;
  return (
    <div role="group" aria-label="Where did you hear about Cinderpaw?" className="rounded-xl border border-border-subtle bg-bg-surface px-3.5 py-2.5 text-xs leading-relaxed text-text-muted sm:col-span-2">
      <span className="font-medium text-text-primary">Where did you hear about Cinderpaw?</span>{' '}
      Optional. It goes with the install count, once, so we know where to say thanks.
      <div className="mt-2 flex flex-wrap gap-1.5">
        {HEARD_FROM.map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={picked === id}
            onClick={() => setPicked(picked === id ? null : id)}
            className={cn(
              'rounded-full border px-2.5 py-1 transition-colors',
              picked === id ? 'border-brand bg-brand text-on-brand' : 'border-border-default text-text-secondary hover:bg-bg-hover',
            )}
          >
            {label}
          </button>
        ))}
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
  const [open, setOpen] = useState(false);
  // What is sent stays in the one visible line; only the how-to-check moves
  // behind Details, so the board does not scroll and the promise is not hidden.
  return (
    <div className="rounded-xl border border-border-subtle bg-bg-surface px-3.5 py-2.5 text-xs leading-relaxed text-text-muted">
      <label className="flex cursor-pointer items-start gap-2.5">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-brand" />
        <span>
          <span className="font-medium text-text-primary">Count this install, once.</span>{' '}
          Sends the version and your operating system one time, nothing about you.{' '}
          <button type="button" onClick={(e) => { e.preventDefault(); setOpen((o) => !o); }} className="text-brand hover:underline" aria-expanded={open}>
            {open ? 'Less' : 'Details'}
          </button>
        </span>
      </label>
      {open && (
        <p className="mt-1.5 pl-6">
          It is sent when you open chat, never again. It is how we know how many
          people actually run Cinderpaw. Untick and nothing is sent at all. Either
          way, <code className="text-micro">~/.cinderpaw/.install-counted</code> is
          written with exactly what happened, so you can check.
        </p>
      )}
    </div>
  );
}

/**
 * The daily usage summary, asked here UNTICKED. Unlike the install count it
 * repeats every day, so it is never assumed. The real payload (or an example
 * day, on a machine with no tasks yet) is one click away, not a promise.
 */
function ShareUsageNotice() {
  const on = useOnboarding((s) => s.shareUsage);
  const setOn = useOnboarding((s) => s.setShareUsage);
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-border-subtle bg-bg-surface px-3.5 py-2.5 text-xs leading-relaxed text-text-muted">
      <label className="flex cursor-pointer items-start gap-2.5">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-brand" />
        <span>
          <span className="font-medium text-text-primary">Help other people pick a model.</span>{' '}
          Once a day, share how many tasks each model did, how long they took and what they cost. Never your messages or files.{' '}
          <button type="button" onClick={(e) => { e.preventDefault(); setOpen((o) => !o); }} className="text-brand hover:underline" aria-expanded={open}>
            {open ? 'Less' : 'See exactly what is sent'}
          </button>
        </span>
      </label>
      {open && <WhatIsSent />}
    </div>
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

  return <DiskLine variant={variant} />;
}

function DiskLine({ variant }: { variant: { Icon: LucideIcon; accent: string; ring: string; title: string; body: string } }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn('rounded-xl border px-3.5 py-2.5 text-xs leading-relaxed text-text-muted', variant.ring)}>
      <p className="flex items-start gap-2.5">
        <variant.Icon size={16} className={cn('mt-px shrink-0', variant.accent)} />
        <span>
          <span className="font-medium text-text-primary">{variant.title}.</span>{' '}
          <button type="button" onClick={() => setOpen((o) => !o)} className="text-brand hover:underline" aria-expanded={open}>
            {open ? 'Less' : 'Details'}
          </button>
        </span>
      </p>
      {open && <p className="mt-1.5 pl-6">{variant.body}</p>}
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
  // First run: the wizard opens a beat after the check, and nothing else may
  // take the screen in that beat either.
  const [due, setDue] = useState(false);

  // The update card, What's new and the usage question wait while the
  // first-run question is open: until we know whether the wizard opens, and
  // while it is open (Darius, 31 Oct: the update card drew over it).
  useEffect(() => {
    useAttention.getState().setWizard(!checked || due || active);
  }, [checked, due, active]);

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
        setDue(true);
        setTimeout(() => { start(); setDue(false); }, 300);
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
