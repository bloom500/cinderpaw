/**
 * #10: inline error card under the message list. Renders the humanized
 * version of `streamError` with an optional fix-it action (open Settings /
 * Models), a Retry button that resends the failed turn, and the raw error
 * tucked into a collapsible detail line.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useChat } from '@/stores/chat';
import { humanizeError } from '@/lib/humanizeError';
import { useResendTurn } from '@/hooks/useResendTurn';


export function StreamErrorNotice() {
  const status = useChat((s) => s.streamStatus);
  const raw = useChat((s) => s.streamError);
  const navigate = useNavigate();
  const resend = useResendTurn();
  const [showDetail, setShowDetail] = useState(false);

  if (status !== 'error' || !raw) return null;
  const err = humanizeError(raw);

  // One resend for the whole app (`useResendTurn`). This used to be its own
  // copy of the logic and it only ever called the chat path, so pressing Retry
  // in agent mode sent the turn past the agent to the local model.
  const retry = () => void resend(useChat.getState().messages.length - 1);

  return (
    <div
      role="alert"
      className="mx-auto max-w-2xl w-full px-4 pb-2"
    >
      <div className="flex items-start gap-2.5 rounded-xl border border-error/30 bg-error/5 px-4 py-3">
        <AlertCircle size={16} className="text-error shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0 space-y-1.5">
          <p className="text-sm text-text-primary leading-relaxed">{err.message}</p>
          {err.detail && err.detail !== err.message && (
            <button
              type="button"
              onClick={() => setShowDetail((v) => !v)}
              className="flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary"
            >
              {showDetail ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              Technical details
            </button>
          )}
          {showDetail && (
            <pre className="text-xs text-text-muted bg-bg-surface border border-border-subtle rounded px-2 py-1.5 max-h-28 overflow-auto whitespace-pre-wrap wrap-break-word">
              {err.detail}
            </pre>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button size="sm" variant="outline" onClick={retry}>
            <RotateCcw size={14} className="mr-1.5" />
            Retry
          </Button>
          {err.action && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigate(err.action === 'settings' ? '/models?tab=cloud' : '/models')}
            >
              {err.actionLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
