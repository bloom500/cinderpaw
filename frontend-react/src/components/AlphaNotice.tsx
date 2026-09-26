import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpRight, Bug, FlaskConical, GitPullRequest, X } from 'lucide-react';
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
        'pointer-events-auto relative w-full rounded-2xl p-4',
        'bg-bg-elevated/85 backdrop-blur-xl backdrop-saturate-150',
        'border border-border-default/50 shadow-2xl shadow-black/30 ring-1 ring-inset ring-white/[0.06]',
      )}
    >
      <div className="flex items-center gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-warning/15 text-warning ring-1 ring-inset ring-warning/25">
          <FlaskConical size={15} />
        </span>
        <p className="min-w-0 flex-1 text-sm font-semibold text-text-primary">Cinderpaw is in alpha</p>
        <button
          type="button"
          onClick={() => setShown(false)}
          aria-label="Dismiss notice"
          className="-mr-1 grid size-7 shrink-0 place-items-center rounded-full text-text-muted transition-colors hover:bg-white/[0.06] hover:text-text-primary"
        >
          <X size={14} />
        </button>
      </div>
      {/* Below 1280 px the card reached the home screen's question and covered
          it, on every launch until "Don't show this again". The title and the
          two buttons say enough there. */}
      <p className="mt-2.5 text-xs leading-relaxed text-text-secondary max-xl:hidden">
        Things can change or break between updates. When something goes wrong, a report from inside the app
        helps more than you would think.
      </p>
      {/* Two buttons of one size, the one that matters most filled. They were
          four orange text links in a ragged line, which read as a footnote. */}
      <div className="mt-3.5 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => {
            setShown(false);
            navigate('/settings?cat=about');
          }}
          className={cn(ACTION, 'bg-brand font-semibold text-on-brand shadow-sm hover:bg-brand-hover')}
        >
          <Bug size={13} />
          Report a bug
        </button>
        <a
          href="https://github.com/bloom500/cinderpaw"
          target="_blank"
          rel="noreferrer"
          className={cn(ACTION, 'border border-border-default/70 bg-white/[0.04] font-medium text-text-primary hover:bg-bg-hover')}
        >
          <GitPullRequest size={13} />
          Contribute
        </a>
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-border-subtle/70 pt-2.5">
        <button
          type="button"
          onClick={never}
          className="text-2xs font-medium text-text-muted transition-colors hover:text-text-primary"
        >
          Don't show this again
        </button>
        <a
          href="https://discord.gg/eqvfVRD6y7"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-0.5 text-2xs font-medium text-text-muted transition-colors hover:text-text-primary"
        >
          Discord
          <ArrowUpRight size={11} />
        </a>
      </div>
    </div>
  );
}

/** The shape both action buttons share: one height, one radius, icon and word centred. */
const ACTION =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-xs transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand/50';
