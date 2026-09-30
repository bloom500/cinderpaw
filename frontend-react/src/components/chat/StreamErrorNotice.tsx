/**
 * The error card under the message list (spec 6, Error card): what happened in
 * plain words, that the message is safe, Try again, a fix-it action when there
 * is one (Settings / Models), and "Show details" for the technical text.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ChevronDown } from 'lucide-react';
import { useChat } from '@/stores/chat';
import { humanizeError } from '@/lib/humanizeError';
import { useResendTurn } from '@/hooks/useResendTurn';
import { cn } from '@/lib/utils';

export function StreamErrorNotice() {
  const status = useChat((s) => s.streamStatus);
  const raw = useChat((s) => s.streamError);
  const navigate = useNavigate();
  const resend = useResendTurn();
  const [showDetail, setShowDetail] = useState(false);

  if (status !== 'error' || !raw) return null;
  const err = humanizeError(raw);
  const hasDetail = !!err.detail && err.detail !== err.message;

  // One resend for the whole app (`useResendTurn`). This used to be its own
  // copy of the logic and it only ever called the chat path, so pressing Retry
  // in agent mode sent the turn past the agent to the local model.
  const retry = () => void resend(useChat.getState().messages.length - 1);

  return (
    <div role="alert" className="mx-auto w-full max-w-2xl px-4 pb-2">
      <div className="rounded-2xl border border-border-default bg-bg-elevated p-4">
        <div className="flex gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-error/10 text-error">
            <AlertTriangle size={16} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="text-sm font-semibold text-text-primary">{err.title}</p>
            {/* The turn stays in the chat: Try again sends it as it was. */}
            <p className="text-sm leading-relaxed text-text-muted">{`${err.message} Your message is safe, nothing was lost.`}</p>
          </div>
        </div>
        <div className="mt-3.5 flex flex-wrap items-center gap-2 pl-11">
          <button
            type="button"
            onClick={retry}
            className="h-8 rounded-lg bg-brand px-3.5 text-sm font-medium text-brand-foreground hover:bg-brand/90"
          >
            Try again
          </button>
          {err.action && (
            <button
              type="button"
              onClick={() => navigate(err.action === 'settings' ? '/models?tab=cloud' : '/models')}
              className="h-8 rounded-lg border border-border-default px-3 text-sm text-text-primary hover:bg-text-primary/5"
            >
              {err.actionLabel}
            </button>
          )}
          {hasDetail && (
            <button
              type="button"
              aria-expanded={showDetail}
              onClick={() => setShowDetail((v) => !v)}
              className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm text-text-muted hover:text-text-primary"
            >
              {showDetail ? 'Hide details' : 'Show details'}
              <ChevronDown size={14} className={cn('transition-transform', showDetail && 'rotate-180')} />
            </button>
          )}
        </div>
        {showDetail && (
          <pre className="mt-3 ml-11 max-h-28 overflow-auto whitespace-pre-wrap wrap-break-word rounded-lg border border-border-subtle bg-bg-surface px-2.5 py-2 text-xs text-text-muted">
            {err.detail}
          </pre>
        )}
      </div>
    </div>
  );
}
