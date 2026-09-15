import { useState } from 'react';
import { ChevronRight, Loader2, Check, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ToolActivity } from '@/hooks/useLiveToolActivity';
import { Widget, summaryOf } from './CallToolScreen';

/**
 * The tools a reply ran, drawn inside the reply.
 *
 * Same widgets as the call, one per tool, in the order they ran, above the
 * text they produced — so "what did it look at" and "what did it say" are one
 * bubble, not a list under the chat and a bubble somewhere above it.
 *
 * Open while the tool runs, folded to one line once the reply is finished: a
 * reply with eight tool calls would otherwise be a screen of cards forever.
 * Click the line to reopen it.
 */
export function MessageToolWidgets({ activity, streaming }: { activity: ToolActivity[]; streaming: boolean }) {
  if (activity.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {activity.map((a) => (
        <Row key={a.id} a={a} streaming={streaming} />
      ))}
    </div>
  );
}

function Row({ a, streaming }: { a: ToolActivity; streaming: boolean }) {
  // `null` is "nobody chose": open while the turn is live, folded after.
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? (streaming || a.status === 'running');

  if (open) {
    return (
      <div>
        <Widget activity={a} flat />
        {!streaming && (
          <button
            type="button"
            onClick={() => setChoice(false)}
            className="mt-0.5 text-micro text-text-muted hover:text-text-secondary"
          >
            hide
          </button>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setChoice(true)}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg border border-border-subtle bg-bg-surface/40 px-2.5 py-1.5 text-left',
        'text-2xs text-text-secondary hover:bg-bg-surface/70 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand',
      )}
    >
      <ChevronRight size={12} className="shrink-0 text-text-muted" />
      <span className="shrink-0 font-medium">{a.tool}</span>
      <span className="min-w-0 flex-1 truncate text-text-muted" title={summaryOf(a)}>{summaryOf(a)}</span>
      {a.status === 'running' ? (
        <Loader2 size={12} className="shrink-0 animate-spin text-brand" />
      ) : a.status === 'failed' ? (
        <AlertTriangle size={12} className="shrink-0 text-(--warning)" />
      ) : (
        <Check size={12} className="shrink-0 text-(--success)" />
      )}
    </button>
  );
}
