/**
 * WorkersCard: the background workers this chat's agent spawned with `rlm()`.
 *
 * A worker is admitted instantly and does its work after the reply that
 * started it has finished, so the reply's own step list never shows it. Before
 * this card it had no UI at all: the agent said "I started three workers" and
 * nothing on screen moved while they spent a paid model in the background.
 *
 * It also carries each worker's answer. The agent is told to collect answers
 * before it ends its turn, but when it does not, this card is the only place
 * the person can read what the worker found.
 *
 * Self-hiding: a chat with no workers renders nothing.
 */

import { useEffect, useMemo, useState } from 'react';
import { Ban, Check, ChevronDown, ChevronRight, Copy, Loader2, Network, X } from 'lucide-react';
import { useChat } from '@/stores/chat';
import { displayName, useRlmWorkers, workersFor, type RlmWorker } from '@/stores/rlmWorkers';
import { copyText } from '@/lib/clipboard';

function elapsed(w: RlmWorker, now: number): string {
  const s = Math.max(0, Math.round(((w.endedAt ?? now) - w.startedAt) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function StatusIcon({ status }: { status: RlmWorker['status'] }) {
  if (status === 'running') return <Loader2 size={14} className="animate-spin text-brand shrink-0" aria-hidden />;
  if (status === 'completed') return <Check size={14} className="text-success shrink-0" aria-hidden />;
  if (status === 'cancelled') return <Ban size={14} className="text-text-muted shrink-0" aria-hidden />;
  return <X size={14} className="text-error shrink-0" aria-hidden />;
}

const STATUS_WORD: Record<RlmWorker['status'], string> = {
  running: 'working',
  completed: 'done',
  error: 'failed',
  cancelled: 'stopped',
};

function WorkerRow({ w, now }: { w: RlmWorker; now: number }) {
  const [showAnswer, setShowAnswer] = useState(false);
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const dismiss = useRlmWorkers((s) => s.dismiss);

  return (
    <li className="py-2 first:pt-0 last:pb-0" data-testid="rlm-worker-row">
      <div className="flex items-center gap-2 min-w-0">
        <StatusIcon status={w.status} />
        <span className="text-sm text-text-primary truncate" title={w.name}>
          {displayName(w.name)}
        </span>
        <span className="text-xs text-text-muted shrink-0">
          {STATUS_WORD[w.status]} · {elapsed(w, now)}
        </span>
        <span className="flex-1" />
        {w.status === 'completed' && w.answer && (
          <button
            type="button"
            onClick={() => setShowAnswer((v) => !v)}
            aria-expanded={showAnswer}
            className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary shrink-0"
          >
            {showAnswer ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Answer
          </button>
        )}
        {w.status !== 'running' && (
          <button
            type="button"
            onClick={() => dismiss(w.childId)}
            aria-label={`Dismiss ${displayName(w.name)}`}
            className="p-0.5 rounded text-text-muted hover:text-text-primary shrink-0"
          >
            <X size={12} />
          </button>
        )}
      </div>
      {/* What it is doing right now, or why it ended. A finished worker's
          detail is only a tool-call count, which the answer toggle replaces. */}
      {w.detail && w.status !== 'completed' && (
        <p className={`mt-0.5 pl-6 text-xs truncate ${w.status === 'error' ? 'text-error' : 'text-text-muted'}`}>
          {w.detail}
        </p>
      )}
      {showAnswer && w.answer && (
        <div className="mt-1.5 ml-6 rounded-lg border border-border-subtle bg-bg-surface/60">
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap wrap-break-word px-2.5 py-2 text-xs text-text-secondary font-sans">
            {w.answer}
          </pre>
          <div className="flex justify-end px-2 pb-1.5">
            <button
              type="button"
              onClick={async () => setCopied((await copyText(w.answer!)) ? 'copied' : 'failed')}
              className="flex items-center gap-1 text-xs text-text-muted hover:text-text-primary"
            >
              <Copy size={12} />
              {copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Could not reach the clipboard' : 'Copy'}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

export function WorkersCard() {
  const sessionId = useChat((s) => s.sessionId);
  const all = useRlmWorkers((s) => s.workers);
  const clearSettled = useRlmWorkers((s) => s.clearSettled);
  const workers = useMemo(() => workersFor(all, sessionId), [all, sessionId]);
  const running = workers.filter((w) => w.status === 'running').length;
  const [open, setOpen] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  // A clock only while something runs: a settled row shows a fixed duration.
  useEffect(() => {
    if (running === 0) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [running]);

  if (workers.length === 0) return null;
  const settled = workers.length - running;

  return (
    <section
      aria-label="Background workers"
      data-testid="rlm-workers-card"
      className="mx-auto max-w-2xl w-full px-4 pb-2"
    >
      <div className="rounded-xl border border-border-default bg-bg-elevated/80 backdrop-blur-md px-3 py-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="flex items-center gap-2 min-w-0 text-left"
          >
            {open ? <ChevronDown size={14} className="text-text-muted" /> : <ChevronRight size={14} className="text-text-muted" />}
            <Network size={14} className="text-text-secondary shrink-0" aria-hidden />
            <span className="text-sm text-text-primary">Workers</span>
            <span className="text-xs text-text-muted" aria-live="polite">
              {running > 0 ? `${running} working` : ''}
              {running > 0 && settled > 0 ? ' · ' : ''}
              {settled > 0 ? `${settled} finished` : ''}
            </span>
          </button>
          <span className="flex-1" />
          {settled > 0 && (
            <button
              type="button"
              onClick={() => clearSettled(sessionId)}
              className="text-xs text-text-muted hover:text-text-primary"
            >
              Clear finished
            </button>
          )}
        </div>
        {open && (
          <ul className="mt-2 divide-y divide-border-subtle max-h-64 overflow-auto">
            {workers.map((w) => (
              <WorkerRow key={w.childId} w={w} now={now} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
