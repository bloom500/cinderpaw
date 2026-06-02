import { cn } from '@/lib/utils';

interface ShellProps {
  step: number;
  totalSteps: number;
  children: React.ReactNode;
  onBack?: () => void;
  onSkip?: () => void;
  onContinue?: () => void;
  continueLabel?: string;
  continueDisabled?: boolean;
  continueBusy?: boolean;
}

export function OnboardingShell({
  step, totalSteps, children,
  onBack, onSkip, onContinue,
  continueLabel = 'Continue →',
  continueDisabled = false,
  continueBusy = false,
}: ShellProps) {
  const pct = Math.round((step / totalSteps) * 100);
  const showStepLabel = step > 1 && step < totalSteps;

  return (
    <div className="flex flex-col h-full">
      {/* Progress line */}
      <div className="h-0.5 w-full bg-bg-hover shrink-0">
        <div
          className="h-full bg-brand transition-all duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Content — vertically + horizontally centered */}
      <div className="flex-1 overflow-y-auto flex flex-col items-center justify-center px-6 py-6">
        <div className="w-full max-w-sm">
          {showStepLabel && (
            <p className="text-xs font-semibold text-brand uppercase tracking-widest text-center mb-6">
              Step {step - 1} of {totalSteps - 2}
            </p>
          )}
          {children}
        </div>
      </div>

      {/* CTA — no border, part of flow */}
      <div className="px-6 pb-8 flex flex-col items-center gap-3 shrink-0 w-full max-w-sm mx-auto">
        {onContinue && (
          <button
            type="button"
            onClick={onContinue}
            disabled={continueDisabled || continueBusy}
            className="w-full py-2.5 rounded-xl bg-brand text-white text-sm font-semibold hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {continueBusy ? 'Saving…' : continueLabel}
          </button>
        )}
        {(onBack || onSkip) && (
          <div className={cn('flex items-center text-xs text-text-muted', onBack && onSkip ? 'gap-4' : '')}>
            {onBack && (
              <button
                type="button"
                onClick={onBack}
                className="hover:text-text-secondary transition-colors"
              >
                ← Back
              </button>
            )}
            {onSkip && (
              <button
                type="button"
                onClick={onSkip}
                className="hover:text-text-secondary transition-colors"
              >
                Skip for now
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
