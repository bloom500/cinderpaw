import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FlaskConical, X } from 'lucide-react';
import { useOnboarding } from '@/stores/onboarding';
import { cn, readLocal, writeLocal } from '@/lib/utils';

/** Where the choice to stop seeing this lives. `never` is the only value. */
export const ALPHA_NOTICE_KEY = 'cinderpaw.alphaNotice';

/** Whether the notice should appear this launch. Storage that cannot be read
 *  counts as "not opted out": showing it once too often is the cheap mistake. */
export function alphaNoticeWanted(): boolean {
  return readLocal(ALPHA_NOTICE_KEY) !== 'never';
}

/**
 * The card that says, on every launch, that this is alpha software.
 *
 * A person who installs Cinderpaw today gets a product that is a month past
 * its last release and still growing a limb a week. They deserve to hear that
 * from the app, before the first bug, not from a GitHub issue afterwards; and
 * the two things they can do about it, report and contribute, should be one
 * click from the sentence that warned them.
 *
 * Two ways out, both instant: the X closes it for this session and it is back
 * next launch; "Don't show this again" is remembered. Hidden while the setup
 * wizard is up, which already has their attention.
 */
export function AlphaNotice() {
  const onboarding = useOnboarding((s) => s.active);
  const [shown, setShown] = useState(alphaNoticeWanted);
  const navigate = useNavigate();
  if (!shown || onboarding) return null;

  const never = () => {
    writeLocal(ALPHA_NOTICE_KEY, 'never');
    setShown(false);
  };

  return (
    <div
      role="status"
      // Same glass as the toasts it stacks with (see Toasts.tsx).
      className={cn(
        'pointer-events-auto relative w-full rounded-xl border border-border-default/60 p-4',
        'bg-bg-elevated/80 backdrop-blur-xl backdrop-saturate-150',
        'shadow-xl shadow-black/25 ring-1 ring-inset ring-white/10',
      )}
    >
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 shrink-0 text-warning">
          <FlaskConical size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-text-primary">Cinderpaw is in alpha</p>
          <p className="mt-1 text-xs text-text-muted">
            Expect bugs and features that change or break between updates. If something goes wrong,
            a bug report from inside the app helps more than you would think, and contributors are
            welcome.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
            <button
              type="button"
              onClick={() => {
                setShown(false);
                navigate('/settings?cat=about');
              }}
              className="text-xs font-medium text-brand hover:underline"
            >
              Report a bug
            </button>
            <a
              href="https://github.com/bloom500/cinderpaw"
              target="_blank"
              rel="noreferrer"
              className="text-xs font-medium text-brand hover:underline"
            >
              Become a contributor
            </a>
            <a
              href="https://discord.gg/eqvfVRD6y7"
              target="_blank"
              rel="noreferrer"
              className="text-xs font-medium text-brand hover:underline"
            >
              Discord
            </a>
            <button
              type="button"
              onClick={never}
              className="ml-auto text-xs text-text-muted hover:text-text-primary hover:underline"
            >
              Don't show this again
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShown(false)}
          aria-label="Dismiss notice"
          className="shrink-0 rounded-md p-1 text-text-muted hover:bg-bg-hover hover:text-text-primary"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
