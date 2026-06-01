import { cn } from '@/lib/utils';

interface ShellProps {
  step: number;          // 1-based, for filled dots
  totalSteps: number;
  children: React.ReactNode;
  onBack?: () => void;   // undefined → hides Back
  onSkip?: () => void;   // undefined → hides Skip
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
  return (
    <div className="flex flex-col h-full">
      {/* Progress dots */}
      <div className="pt-8 pb-6 flex justify-center gap-2">
        {Array.from({ length: totalSteps }, (_, i) => (
          <span
            key={i}
            className={cn(
              'w-2 h-2 rounded-full transition-colors',
              i < step ? 'bg-brand' : 'bg-bg-hover',
            )}
          />
        ))}
      </div>

      {/* Step content */}
      <div className="flex-1 overflow-y-auto px-6 pb-4">
        {children}
      </div>

      {/* Footer buttons */}
      <div className="px-6 py-4 border-t border-border-subtle flex items-center justify-between gap-3 shrink-0">
        <div>
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="text-sm text-text-muted hover:text-text-secondary transition-colors"
            >
              ← Back
            </button>
          )}
        </div>
        <div className="flex items-center gap-3">
          {onSkip && (
            <button
              type="button"
              onClick={onSkip}
              className="text-sm text-text-muted hover:text-text-secondary transition-colors"
            >
              Skip for now
            </button>
          )}
          {onContinue && (
            <button
              type="button"
              onClick={onContinue}
              disabled={continueDisabled || continueBusy}
              className="px-4 py-1.5 rounded-md bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {continueBusy ? 'Saving…' : continueLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
