import { useEffect, useState } from 'react';
import { Check, Globe, Send, ShieldAlert, ShoppingCart, Trash2, X, type LucideIcon } from 'lucide-react';
import { useChat } from '@/stores/chat';
import type { CoworkExchange } from '@/stores/coworkTranscript';
import { cn } from '@/lib/utils';

/**
 * The escalation classes of `cowork/approval.ts`, with their words and weight.
 * Heavy ones (money, deletion, production) are red; the rest amber. A request
 * with no class shows no badge: there is no invented risk score (spec 7.5).
 */
const CLASSES: Record<string, { label: string; icon: LucideIcon; heavy: boolean }> = {
  send:        { label: 'Send',              icon: Send,         heavy: false },
  publish:     { label: 'Publish',           icon: Globe,        heavy: false },
  delete:      { label: 'Delete',            icon: Trash2,       heavy: true },
  purchase:    { label: 'Purchase',          icon: ShoppingCart, heavy: true },
  prod_change: { label: 'Production change', icon: ShieldAlert,  heavy: true },
};

/** Details longer than this fold behind "Show more". */
const FOLD_AT = 220;

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * An action waiting for a yes, as a card in the chat (spec 7.5): what will
 * happen, its details (the command, the path, the recipient: the request's own
 * text), the real class as a badge, Deny and Approve. Once answered it says
 * how it ended; an expired request says nothing was done, because expiry
 * denies (the existing fail-closed rule).
 */
export function ApprovalCard({ e }: { e: CoworkExchange }) {
  const cls = e.approvalClass ? CLASSES[e.approvalClass] : undefined;
  const Icon = cls?.icon ?? ShieldAlert;
  const who = e.fromName || e.fromAgentId;
  const pending = e.status === 'running';
  const requestId = e.id.startsWith('approval:') ? e.id.slice('approval:'.length) : null;
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!pending) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [pending]);

  const answer = async (approve: boolean) => {
    if (!requestId) return;
    setSending(true);
    setFailed(null);
    try {
      await useChat.getState().resolveCoworkApproval(requestId, approve);
    } catch (err) {
      // Hand the decision back: the teammate is blocked on this answer.
      setSending(false);
      setFailed(err instanceof Error ? err.message : String(err));
    }
  };

  const details = e.requestText ?? '';
  const long = details.length > FOLD_AT;
  const outcome = pending ? null
    : e.outcome === 'expired' ? 'Timed out, so nothing was done'
    : e.outcome === 'denied' || e.status === 'error' ? 'Denied, so nothing was done'
    : 'Approved';

  return (
    <div
      role="group"
      aria-label={`${who} asks: ${cls?.label ?? 'approval'}`}
      className={cn('rounded-2xl border bg-bg-surface p-4', pending ? 'border-warning/40' : 'border-border-default')}
    >
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-bg-active text-brand"><Icon size={16} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-text-primary">{who} wants your OK</span>
            {cls && (
              // Not through cn(): tailwind-merge takes `text-micro` for a colour
              // and drops it next to `text-error`, so the size would be lost.
              <span className={`rounded-full px-2 py-px text-micro font-semibold ${cls.heavy ? 'bg-error/15 text-error' : 'bg-warning/15 text-warning'}`}>
                {cls.label}
              </span>
            )}
            {pending && e.startedAt !== undefined && (
              <span className="ml-auto text-2xs tabular-nums text-text-disabled">{elapsed(now - e.startedAt)}</span>
            )}
          </div>
          {details && (
            <p className={cn('mt-1.5 whitespace-pre-wrap wrap-break-word font-mono text-xs text-text-secondary', long && !more && 'line-clamp-3')}>
              {details}
            </p>
          )}
          {long && (
            <button type="button" onClick={() => setMore((v) => !v)} className="mt-1 text-2xs text-text-muted hover:text-text-secondary">
              {more ? 'Show less' : 'Show more'}
            </button>
          )}
          {pending ? (
            <div className="mt-3 flex items-center gap-2">
              {sending ? (
                <span className="text-xs text-text-muted">Sending…</span>
              ) : requestId ? (
                <>
                  <button type="button" onClick={() => void answer(false)}
                    className="rounded-lg border border-border-default bg-bg-elevated px-3.5 py-1.5 text-sm font-medium text-text-primary hover:bg-text-primary/5">
                    Deny
                  </button>
                  <button type="button" onClick={() => void answer(true)}
                    className="rounded-lg bg-brand px-3.5 py-1.5 text-sm font-medium text-brand-foreground hover:opacity-90">
                    Approve
                  </button>
                  <span className="text-2xs text-text-disabled">No answer in 5 minutes counts as no.</span>
                </>
              ) : null}
            </div>
          ) : (
            <p className={cn('mt-2 flex items-center gap-1.5 text-xs', outcome === 'Approved' ? 'text-success' : 'text-text-muted')}>
              {outcome === 'Approved' ? <Check size={14} /> : <X size={14} />}
              {outcome}
            </p>
          )}
          {failed && <p className="mt-1.5 text-xs text-error">Not sent: {failed}</p>}
        </div>
      </div>
    </div>
  );
}
