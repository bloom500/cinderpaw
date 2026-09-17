import { useState, type ReactNode } from 'react';
import { Check, Copy, Pencil, RotateCcw, X } from 'lucide-react';
import { copyText } from '@/lib/clipboard';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * The row of actions under a message, after AI Elements' `Actions`.
 *
 * Copying a reply had no button at all: the only copy in the app was on a code
 * block, so getting a whole answer out meant dragging across the transcript and
 * picking up the timestamps with it. A user message had neither copy nor edit,
 * so a typo meant retyping the whole question.
 *
 * Shown on hover on a pointer device and always on touch, where there is no
 * hover to reveal them with.
 */
function Action({
  label,
  done,
  onClick,
  children,
}: {
  label: string;
  done?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={done ?? label}
          className="p-1.5 rounded-md text-text-muted hover:text-text-secondary hover:bg-bg-elevated
                     opacity-0 group-hover:opacity-100 focus-visible:opacity-100
                     max-md:opacity-100 transition-opacity outline-hidden"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{done ?? label}</TooltipContent>
    </Tooltip>
  );
}

export function MessageActions({
  text,
  onRetry,
  onEdit,
  className,
}: {
  text: string;
  onRetry?: () => void;
  onEdit?: () => void;
  className?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  // Says what happened, not what was attempted. The first version of this
  // button showed a tick whether or not the text reached the clipboard, which
  // is how a dead clipboard plugin looked like a working button.
  const copy = async () => {
    setState((await copyText(text)) ? 'copied' : 'failed');
    setTimeout(() => setState('idle'), 1600);
  };

  if (!text.trim() && !onRetry) return null;

  return (
    <TooltipProvider delayDuration={200}>
      <div className={cn('flex items-center gap-0.5 -ml-1.5', className)}>
        {text.trim() && (
          <Action
            label="Copy"
            done={state === 'copied' ? 'Copied' : state === 'failed' ? 'Could not reach the clipboard' : undefined}
            onClick={copy}
          >
            {state === 'copied'
              ? <span className="flex items-center gap-1 text-success"><Check size={14} /><span className="text-micro">Copied</span></span>
              : state === 'failed'
                ? <span className="flex items-center gap-1 text-error"><X size={14} /><span className="text-micro">Failed</span></span>
                : <Copy size={14} />}
          </Action>
        )}
        {onEdit && (
          <Action label="Edit" onClick={onEdit}>
            <Pencil size={14} />
          </Action>
        )}
        {onRetry && (
          <Action label="Try again" onClick={onRetry}>
            <RotateCcw size={14} />
          </Action>
        )}
      </div>
    </TooltipProvider>
  );
}
