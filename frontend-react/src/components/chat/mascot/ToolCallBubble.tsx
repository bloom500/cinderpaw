/**
 * ToolCallBubble — single pill-shaped indicator for one tool call.
 *
 * Visual: emoji + tool name + (main arg) on the left; status icon + elapsed
 * seconds on the right. The left border is colour-coded by status.
 */

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';

export interface ToolCallBubbleProps {
  emoji: string;
  label: string;
  mainArg: string | null;
  status: 'running' | 'done' | 'error';
  startedAt: number;
  endedAt: number | null;
}

const STATUS_BORDER: Record<ToolCallBubbleProps['status'], string> = {
  running: 'border-l-brand',
  done: 'border-l-text-muted',
  error: 'border-l-red-500',
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
}: ToolCallBubbleProps) {
  const elapsed = useElapsedMs(startedAt, endedAt);
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
        'pointer-events-none select-none',
        'inline-flex items-center gap-1.5 whitespace-nowrap',
        'px-2 py-1 rounded-md',
        'bg-bg-elevated border border-border-default',
        'border-l-2',
        STATUS_BORDER[status],
        'text-[11px] text-text-primary shadow-sm',
      )}
    >
      <span aria-hidden="true">{emoji}</span>
      <span className="font-medium">{label}</span>
      {mainArg && <span className="text-text-muted">({mainArg})</span>}
      <span className="ml-1 text-text-muted inline-flex items-center gap-0.5">
        {status === 'running' && <span>⏱</span>}
        {status === 'done' && <span>✓</span>}
        {status === 'error' && <span>!</span>}
        <span>{formatMs(elapsed)}</span>
      </span>
    </motion.div>
  );
}
