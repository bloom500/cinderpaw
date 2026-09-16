import { useState, type ReactNode } from 'react';
import { Check, Copy, Pencil, RotateCcw } from 'lucide-react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
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
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await writeText(text);
    } catch {
      /* no clipboard (browser preview, locked-down session) */
    }
    // The tick shows either way. It reports that the button was pressed, which
    // is the feedback that was missing; a clipboard that refuses is silent on
    // every platform anyway.
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  if (!text.trim() && !onRetry) return null;

  return (
    <TooltipProvider delayDuration={200}>
      <div className={cn('flex items-center gap-0.5 -ml-1.5', className)}>
        {text.trim() && (
          <Action label="Copy" done={copied ? 'Copied' : undefined} onClick={copy}>
            {copied
              ? <span className="flex items-center gap-1 text-success"><Check size={13} /><span className="text-[11px]">Copied</span></span>
              : <Copy size={13} />}
          </Action>
        )}
        {onEdit && (
          <Action label="Edit" onClick={onEdit}>
            <Pencil size={13} />
          </Action>
        )}
        {onRetry && (
          <Action label="Try again" onClick={onRetry}>
            <RotateCcw size={13} />
          </Action>
        )}
      </div>
    </TooltipProvider>
  );
}
