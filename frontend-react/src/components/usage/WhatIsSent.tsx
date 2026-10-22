import { useEffect, useState } from 'react';
import { tauri } from '@/lib/tauri';
import type { UsagePayload } from '@/lib/tauri/events';

// What one day looks like, for a machine that has no finished task yet. On a
// fresh install the real preview is empty, and an empty box tells a stranger
// nothing about what they are agreeing to. Same shape as the real thing.
const EXAMPLE: UsagePayload = {
  v: 1, code: '(a random code, new every month)', day: '2026-10-08', app: '2026.10.x', os: 'windows',
  groups: [{
    provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5', tasks_part: 12, tasks_main: 9,
    outcomes: { completed: 8, stuck: 0, out_of_time: 0, ceiling: 0, stopped: 1, no_answer: 0, error: 0 },
    errors: { network: 0, auth: 0, billing: 0, rate_limit: 0, context_overflow: 0, provider_error: 0, tool_error: 0, other: 0 },
    thumbs_up: 3, thumbs_down: 1, tokens_in: 48210, tokens_out: 5120, cache_read: 30100, cache_write: null,
    cost_reported_usd: 0.21, cost_estimated_usd: 0, duration_buckets: [2, 4, 2, 1, 0, 0, 0, 0],
    tool_calls: 17, fallbacks: 0, retries: 1, by_flags: { brsi0_mem1: { tasks: 9, completed: 8, up: 3, down: 1 } },
  }],
};

/** Shows the real payload this machine would send for yesterday, or the log of what was sent. */
export function WhatIsSent({ showLog = false }: { showLog?: boolean }) {
  const [text, setText] = useState('Loading…');
  useEffect(() => {
    tauri.usage.summary().then(
      (s) => {
        if (showLog) setText(s.sent.length ? s.sent.join('\n') : 'Nothing has been sent yet.');
        else if (s.preview) setText(JSON.stringify(s.preview, null, 2));
        else setText(`No tasks yet, so nothing would be sent. One day looks like this:\n\n${JSON.stringify(EXAMPLE, null, 2)}`);
      },
      // During setup the agent may not be running yet; the shape is still worth showing.
      () => setText(showLog
        ? 'Cinderpaw could not load this right now. Try again in a moment.'
        : `Cinderpaw could not read this computer's numbers right now. One day looks like this:\n\n${JSON.stringify(EXAMPLE, null, 2)}`),
    );
  }, [showLog]);
  return (
    <pre className="mt-2 max-h-64 overflow-auto rounded-lg border border-border-subtle bg-bg-base p-3 text-micro leading-relaxed text-text-secondary whitespace-pre-wrap">
      {text}
    </pre>
  );
}
