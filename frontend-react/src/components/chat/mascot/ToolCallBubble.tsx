/**
 * ToolCallBubble — single pill-shaped indicator for one tool call.
 *
 * Visual: emoji + tool name + (main arg) on the left; status icon + elapsed
 * seconds on the right. The left border is colour-coded by status.
 *
 * #18: bubbles are interactive — clicking a finished bubble expands the
 * tool's output (or its error), and a running bubble shows live
 * progress/retry notes from `tool_progress` events.
 */

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';

export interface ToolCallBubbleProps {
  emoji: string;
  label: string;
  mainArg: string | null;
  status: 'running' | 'done' | 'error' | 'cancelled';
  startedAt: number;
  endedAt: number | null;
  resultPreview?: string | null;
  errorMessage?: string | null;
  progressNote?: string | null;
}

const STATUS_BORDER: Record<ToolCallBubbleProps['status'], string> = {
  running: 'border-l-brand',
  done: 'border-l-text-muted',
  error: 'border-l-red-500',
  // Amber, not red: the user stopped this on purpose. Painting a deliberate
  // stop the same as a crash is how people learn to ignore red.
  cancelled: 'border-l-amber-500',
};

function useElapsedMs(startedAt: number, endedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (endedAt !== null) return;
    const id = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(id);
  }, [endedAt]);
  return (endedAt ?? now) - startedAt;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function ToolCallBubble({
  emoji,
  label,
  mainArg,
  status,
  startedAt,
  endedAt,
  resultPreview,
  errorMessage,
  progressNote,
}: ToolCallBubbleProps) {
  const elapsed = useElapsedMs(startedAt, endedAt);
  const [expanded, setExpanded] = useState(false);
  const detail = errorMessage || resultPreview || null;
  const expandable = status !== 'running' && !!detail;

  return (
    <motion.div
      role="status"
      aria-live="polite"
      layout
      initial={{ opacity: 0, y: 6, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.95 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className={cn(
        'select-none flex flex-col items-stretch',
        'px-2 py-1 rounded-md',
        'bg-bg-elevated border border-border-default',
        'border-l-2',
        STATUS_BORDER[status],
        'text-2xs text-text-primary shadow-sm',
        expandable && 'pointer-events-auto cursor-pointer',
      )}
      onClick={expandable ? () => setExpanded((v) => !v) : undefined}
      title={expandable ? 'Click to view output' : undefined}
    >
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <span aria-hidden="true">{emoji}</span>
        <span className="font-medium">{label}</span>
        {mainArg && <span className="text-text-muted">({mainArg})</span>}
        <span className="ml-1 text-text-muted inline-flex items-center gap-0.5">
          {status === 'running' && <span>⏱</span>}
          {status === 'done' && <span>✓</span>}
          {status === 'error' && <span>!</span>}
          {status === 'cancelled' && <span>⏹</span>}
          <span>{formatMs(elapsed)}</span>
        </span>
      </span>
      {/* #18: live retry/backoff/fallback note while the tool is running */}
      {status === 'running' && progressNote && (
        <span className="text-micro text-text-muted mt-0.5 max-w-[16rem] truncate">
          {progressNote}
        </span>
      )}
      {expanded && detail && (
        <pre
          className={cn(
            'mt-1 max-w-[20rem] max-h-32 overflow-auto whitespace-pre-wrap break-words',
            'rounded bg-bg-surface border border-border-subtle px-1.5 py-1 text-micro',
            errorMessage ? 'text-error' : 'text-text-muted',
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {detail}
        </pre>
      )}
    </motion.div>
  );
}
