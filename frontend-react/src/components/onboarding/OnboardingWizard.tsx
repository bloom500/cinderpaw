/**
 * OnboardingWizard — first-run experience.
 *
 * 4 steps, each with a single clear purpose:
 *   1. Welcome          — greet the user, set expectations
 *   2. Personalize      — ask for the user's name + a name for the agent
 *   3. Showcase         — 3 example capabilities (read-only cards)
 *   4. Done             — final CTA: open the chat
 *
 * Why so short: the user just opened the app. They don't want to fill in
 * 5 forms about workspace, model, permissions, etc. — that's the agent's
 * job to figure out. The only thing a first-time user can meaningfully
 * decide is: "what should I call this thing, and what should it call me?"
 *
 * Why these specific inputs:
 *   - userName: lets the agent address the user by name (personal touch)
 *   - agentName: lets the user feel ownership ("my assistant Bob")
 *   Both names are also injected into the agent's system prompt as a
 *   USER block so the model can use them naturally.
 *
 * Skippable. If the user dismisses, defaults are used and they can
 * re-open the wizard from Settings later.
 */

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowRight, ArrowLeft, Sparkles, X, FileText, Search, Terminal, Cpu, ShieldCheck, ShieldAlert, Shield } from 'lucide-react';
import { useOnboarding } from '@/stores/onboarding';
import { useSystemInfo } from '@/stores/systemInfo';
import { recommendModel } from '@/lib/hardwareRecommendation';
import { tauri, type DiskEncryptionStatus } from '@/lib/tauri';
import { FeralMascot } from '@/components/chat/mascot/FeralMascot';
import { cn } from '@/lib/utils';

const stepVariants = {
  enter: { opacity: 0, y: 12 },
  center: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -12 },
};

export function OnboardingWizard() {
  const active = useOnboarding((s) => s.active);
  const step = useOnboarding((s) => s.step);
  const totalSteps = useOnboarding((s) => s.totalSteps);
  const prev = useOnboarding((s) => s.prev);
  const skip = useOnboarding((s) => s.skip);

  if (!active) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg-primary/95 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
    >
      <div className="w-full max-w-2xl mx-4 bg-bg-elevated border border-border-default rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Top bar: progress + skip */}
        <header className="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
          <ProgressDots step={step} total={totalSteps} />
          <button
            type="button"
            onClick={skip}
            className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded transition-colors"
            aria-label="Skip onboarding"
          >
            <X size={14} className="inline -mt-0.5 mr-1" /> Skip
          </button>
        </header>

        {/* Step content */}
        <div className="flex-1 overflow-y-auto px-6 py-8">
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              variants={stepVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              {step === 0 && <WelcomeStep />}
              {step === 1 && <PersonalizeStep />}
              {step === 2 && <ShowcaseStep />}
              {step === 3 && <DoneStep />}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Bottom bar: back / next */}
        <footer className="flex items-center justify-between px-6 py-4 border-t border-border-subtle">
          <button
            type="button"
            onClick={prev}
            disabled={step === 0}
            className="text-sm text-text-muted hover:text-text-primary px-3 py-1.5 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ArrowLeft size={14} className="inline -mt-0.5 mr-1" /> Back
          </button>
          <StepNavigation step={step} totalSteps={totalSteps} />
        </footer>
      </div>
    </div>
  );
}

function ProgressDots({ step, total }: { step: number; total: number }) {
  return (
    <div className="flex items-center gap-1.5" aria-label={`Step ${step + 1} of ${total}`}>
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={cn(
            'h-1.5 rounded-full transition-all duration-300',
            i === step ? 'w-8 bg-brand' : i < step ? 'w-1.5 bg-brand/50' : 'w-1.5 bg-border-default',
          )}
        />
      ))}
    </div>
  );
}

function StepNavigation({ step, totalSteps }: { step: number; totalSteps: number }) {
  const next = useOnboarding((s) => s.next);
  const finish = useOnboarding((s) => s.finish);
  const userName = useOnboarding((s) => s.userName);
  const isLast = step === totalSteps - 1;
  const isPersonalize = step === 1;
  const canProceed = !isPersonalize || userName.trim().length > 0;

  if (isLast) {
    return (
      <button
        type="button"
        onClick={() => void finish()}
        className="text-sm font-medium px-4 py-2 rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors"
      >
        Open chat <ArrowRight size={14} className="inline -mt-0.5 ml-1" />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={next}
      disabled={!canProceed}
      className="text-sm font-medium px-4 py-2 rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
    >
      Continue <ArrowRight size={14} className="inline -mt-0.5 ml-1" />
    </button>
  );
}

// ── Step 1: Welcome ─────────────────────────────────────────────────────────

function WelcomeStep() {
  return (
    <div className="text-center space-y-6">
      {/* #25: the mascot that lives on the chat input greets the user here
          first — same pixel-art component, brand continuity from minute one. */}
      <motion.div
        initial={{ scale: 0.8, rotate: -10 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ type: 'spring', duration: 0.5 }}
        className="flex justify-center [&_canvas]:w-24 [&_canvas]:h-24 [&_canvas]:[image-rendering:pixelated]"
        aria-hidden
      >
        <FeralMascot state="wave" />
      </motion.div>
      <h1 id="onboarding-title" className="text-3xl font-semibold text-text-primary">
        Welcome to Feral
      </h1>
      <p className="text-base text-text-muted max-w-md mx-auto leading-relaxed">
        A local AI agent that helps you with your files, projects, and tasks,
        without sending your data to the cloud.
      </p>
    </div>
  );
}

// ── Step 2: Personalize ─────────────────────────────────────────────────────

function PersonalizeStep() {
  const userName = useOnboarding((s) => s.userName);
  const setUserName = useOnboarding((s) => s.setUserName);
  const agentName = useOnboarding((s) => s.agentName);
  const setAgentName = useOnboarding((s) => s.setAgentName);

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-semibold text-text-primary mb-2">
          Let's get to know each other
        </h2>
        <p className="text-sm text-text-muted">
          The names you pick here are the ones I'll use when we talk.
        </p>
      </div>

      <div className="space-y-5">
        <Field
          label="What should I call you?"
          hint="I'll use this to address you in our conversation."
        >
          <input
            type="text"
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
            placeholder="e.g. Darius"
            autoFocus
            maxLength={40}
            className="w-full text-base px-3 py-2.5 rounded-lg border border-border-default bg-bg-primary text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand transition-colors"
            aria-label="Your name"
          />
        </Field>

        <Field
          label="What should you call me?"
          hint={'You can leave "Feral" or pick something else.'}
        >
          <input
            type="text"
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            placeholder="Feral"
            maxLength={40}
            className="w-full text-base px-3 py-2.5 rounded-lg border border-border-default bg-bg-primary text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand transition-colors"
            aria-label="Agent name"
          />
        </Field>
      </div>

      <Preview userName={userName} agentName={agentName} />
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-text-primary block">{label}</span>
      {hint && <span className="text-xs text-text-muted block">{hint}</span>}
      {children}
    </label>
  );
}

function Preview({ userName, agentName }: { userName: string; agentName: string }) {
  const safeName = userName.trim() || 'you';
  const safeAgent = agentName.trim() || 'Feral';
  return (
    <div className="rounded-lg bg-bg-primary/50 border border-border-subtle p-4 text-sm space-y-2">
      <p className="text-text-muted text-xs uppercase tracking-wider font-medium">
        Preview
      </p>
      <p className="text-text-primary">
        <span className="text-text-muted">{safeName}:</span>{' '}
        Hi, I have a question.
      </p>
      <p className="text-text-primary">
        <span className="text-brand">{safeAgent}:</span>{' '}
        Sure, {safeName}! What can I help you with?
      </p>
    </div>
  );
}

// ── Step 3: Showcase ────────────────────────────────────────────────────────

function ShowcaseStep() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-text-primary mb-2">
          What I can do for you
        </h2>
        <p className="text-sm text-text-muted">
          A few examples. You don't have to remember anything, just talk to me normally.
        </p>
      </div>

      <div className="grid gap-3">
        <ShowcaseCard
          icon={<FileText size={20} />}
          title="Read and write files"
          example={'„Summarize README.md" or „Create a notes.md file with today\'s ideas"'}
        />
        <ShowcaseCard
          icon={<Search size={20} />}
          title="Search the web"
          example={'„Look up the best practices for Rust error handling"'}
        />
        <ShowcaseCard
          icon={<Terminal size={20} />}
          title="Run commands, tests, builds"
          example={'„Run the tests and show me what failed"'}
        />
      </div>
    </div>
  );
}

function ShowcaseCard({
  icon,
  title,
  example,
}: {
  icon: React.ReactNode;
  title: string;
  example: string;
}) {
  return (
    <div className="flex gap-3 p-3.5 rounded-lg border border-border-subtle bg-bg-primary/30 hover:bg-bg-primary/60 transition-colors">
      <div className="shrink-0 w-9 h-9 rounded-md bg-brand/10 text-brand flex items-center justify-center">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-text-primary">{title}</p>
        <p className="text-xs text-text-muted mt-0.5 leading-relaxed">{example}</p>
      </div>
    </div>
  );
}

// ── Step 4: Done ────────────────────────────────────────────────────────────

function DoneStep() {
  const userName = useOnboarding((s) => s.userName);
  const agentName = useOnboarding((s) => s.agentName);
  const safeName = userName.trim() || 'you';
  const safeAgent = agentName.trim() || 'Feral';
  // #15: turn the hardware detection (SystemBar already has it) into a
  // concrete "what model should I download" hint at the exact moment the
  // user is about to face an empty Models page.
  const sysInfo = useSystemInfo((s) => s.info);
  const fetchSysInfo = useSystemInfo((s) => s.fetch);
  useEffect(() => { void fetchSysInfo(); }, [fetchSysInfo]);
  const rec = recommendModel(sysInfo);

  return (
    <div className="text-center space-y-6">
      <motion.div
        initial={{ scale: 0, rotate: -90 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ type: 'spring', duration: 0.6, delay: 0.1 }}
        className="text-6xl"
        aria-hidden
      >
        🎉
      </motion.div>
      <h2 className="text-2xl font-semibold text-text-primary">
        You're all set, {safeName}!
      </h2>
      <p className="text-base text-text-muted max-w-md mx-auto leading-relaxed">
        I'm <span className="text-brand font-medium">{safeAgent}</span>, ready to go.
        Ask me anything and we'll see what I can do.
      </p>
      {rec && (
        <div className="mx-auto max-w-md text-left rounded-lg border border-border-subtle bg-bg-primary/50 p-4 space-y-1.5">
          <p className="flex items-center gap-1.5 text-xs uppercase tracking-wider font-medium text-text-muted">
            <Cpu size={12} /> For your hardware
          </p>
          <p className="text-sm text-text-primary leading-relaxed">{rec.rationale}</p>
          <p className="text-xs text-text-muted">
            In <span className="text-text-secondary">Models → Browse</span>, look for{' '}
            <span className="text-brand font-medium">{rec.sizeClass}</span> models with a{' '}
            <span className="text-brand font-medium">{rec.quant}</span> file ({rec.approxFileSize}) —
            the download button preselects the best-fitting variant automatically.
          </p>
        </div>
      )}
      <DiskEncryptionNotice />

      <div className="flex items-center justify-center gap-1.5 text-xs text-text-muted">
        <Sparkles size={12} />
        <span>You can change names anytime in Settings</span>
      </div>
    </div>
  );
}

/**
 * At-rest data protection notice (H-1). Feral keeps everything local, so the
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
      accent: 'text-emerald-500',
      ring: 'border-emerald-500/30 bg-emerald-500/5',
      title: 'Your data is protected at rest',
      body: 'Disk encryption is on, so your conversations and memory are safe even if this device is lost.',
    },
    off: {
      Icon: ShieldAlert,
      accent: 'text-amber-500',
      ring: 'border-amber-500/30 bg-amber-500/5',
      title: 'Turn on disk encryption',
      body: 'Your data lives only on this device — enable BitLocker (Windows) or FileVault (macOS) so it stays private if the device is lost or stolen.',
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
      <variant.Icon size={18} className={cn('shrink-0 mt-0.5', variant.accent)} />
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
  const [checked, setChecked] = useState(false);

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
