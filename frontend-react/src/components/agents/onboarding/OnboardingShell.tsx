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
  // The welcome and done screens don't count as "steps" in the dots.
  const dotCount = totalSteps - 2;
  const activeDot = step - 1; // 0 on welcome (no dot active), 1..n during steps

  return (
    <div className="flex flex-col h-full">
      {/* Content — vertically + horizontally centered */}
      <div className="flex-1 overflow-y-auto flex flex-col items-center justify-center px-6 py-6">
        <div className="w-full max-w-md">
          {/* Friendly step dots instead of a raw progress line */}
          {activeDot >= 1 && activeDot <= dotCount && (
            <div className="flex items-center justify-center gap-2 mb-8" aria-label={`Step ${activeDot} of ${dotCount}`}>
              {Array.from({ length: dotCount }, (_, i) => (
                <span
                  key={i}
                  className={cn(
                    'h-1.5 rounded-full transition-all duration-300',
                    i + 1 === activeDot ? 'w-6 bg-brand' : i + 1 < activeDot ? 'w-1.5 bg-brand/60' : 'w-1.5 bg-bg-hover',
                  )}
                />
              ))}
            </div>
          )}
          {children}
        </div>
      </div>

      {/* CTA — no border, part of flow */}
      <div className="px-6 pb-8 flex flex-col items-center gap-3 shrink-0 w-full max-w-md mx-auto">
        {onContinue && (
          <button
            type="button"
            onClick={onContinue}
            disabled={continueDisabled || continueBusy}
            className="w-full py-2.5 rounded-xl bg-brand text-on-brand text-sm font-semibold hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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
