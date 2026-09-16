import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * The row of actions under a finished reply, after AI Elements' `Actions`.
 *
 * Copying a reply had no button at all: the only copy in the app was the one on
 * a code block, so getting a whole answer out meant selecting it by hand, and a
 * drag across a chat transcript picks up the timestamps around it. Every mature
 * chat has this and its absence is one of the things that reads as unfinished.
 *
 * Shown on hover on a pointer device, always visible on touch, where there is
 * no hover to reveal it with.
 */
export function MessageActions({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* no clipboard (browser preview, locked-down session): the button just does nothing */
    }
  };

  if (!text.trim()) return null;

  return (
    <TooltipProvider delayDuration={300}>
      <div className={cn('flex items-center gap-1 -ml-1', className)}>
        <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={copy}
            aria-label={copied ? 'Copied' : 'Copy message'}
            className="p-1.5 rounded-md text-text-muted hover:text-text-secondary hover:bg-bg-elevated
                       opacity-0 group-hover:opacity-100 focus-visible:opacity-100
                       md:opacity-0 max-md:opacity-100 transition-opacity outline-hidden"
          >
            {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
          </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{copied ? 'Copied' : 'Copy'}</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}
