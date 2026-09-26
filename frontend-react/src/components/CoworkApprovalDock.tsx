/**
 * CoworkApprovalDock: a teammate's approval request, wherever the person is.
 *
 * The request is answered in the Agent Cowork panel of the chat it belongs to,
 * and that panel only exists on that chat's page. From Home, Settings or
 * another chat nothing showed it, and after five minutes it expired: the
 * teammate's work silently did not happen. This card sits in the app-wide
 * notification column and shows every pending request except the ones the
 * open chat's panel is already showing.
 */

import { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { ShieldAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useChat } from '@/stores/chat';
import { useCoworkTranscript, type CoworkExchange } from '@/stores/coworkTranscript';

/** The chat a request belongs to, when it has a real one to open. */
function chatOf(e: CoworkExchange): string | null {
  return e.threadId && e.threadId !== 'direct' ? e.threadId : null;
}

function Request({ e }: { e: CoworkExchange }) {
  const navigate = useNavigate();
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const requestId = e.id.startsWith('approval:') ? e.id.slice('approval:'.length) : null;
  const who = e.fromName || e.fromAgentId;
  const chat = chatOf(e);

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

  return (
    <motion.div
      initial={{ opacity: 0, x: 24, scale: 0.96 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 24, scale: 0.96 }}
      transition={{ type: 'spring', stiffness: 420, damping: 34, mass: 0.8 }}
      role="alertdialog"
      aria-label={`${who} needs your approval`}
      data-testid="cowork-approval-dock"
      className={cn(
        'pointer-events-auto relative w-full rounded-xl border border-warning/40 p-3.5',
        'bg-bg-elevated/85 backdrop-blur-xl backdrop-saturate-150',
        'shadow-xl shadow-black/25 ring-1 ring-inset ring-white/10',
      )}
    >
      <div className="flex items-start gap-2.5">
        <ShieldAlert size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-text-primary">{who} needs your approval</p>
          {e.requestText && (
            <p className="mt-1 wrap-break-word font-mono text-xs text-text-secondary">{e.requestText}</p>
          )}
          <p className="mt-1 text-2xs text-text-muted">
            They are waiting. With no answer in 5 minutes it is refused.
          </p>
          <div className="mt-2.5 flex items-center gap-2">
            {sending ? (
              <span className="text-xs text-text-muted">Sending…</span>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => void answer(true)}
                  className="rounded-full border border-brand/40 bg-brand/15 px-3 py-1 text-xs font-medium text-text-primary hover:bg-brand/25"
                >
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => void answer(false)}
                  className="rounded-full border border-error/40 bg-error/10 px-3 py-1 text-xs font-medium text-text-primary hover:bg-error/20"
                >
                  Deny
                </button>
              </>
            )}
            <span className="flex-1" />
            {chat && (
              <button
                type="button"
                onClick={() => navigate(`/chat/${chat}`)}
                className="text-xs text-text-muted hover:text-text-primary"
              >
                Open chat
              </button>
            )}
          </div>
          {failed && <p className="mt-1.5 text-xs text-error">Not sent: {failed}</p>}
        </div>
      </div>
    </motion.div>
  );
}

export function CoworkApprovalDock() {
  const exchanges = useCoworkTranscript((s) => s.exchanges);
  const activeThreadId = useCoworkTranscript((s) => s.activeThreadId);
  const { pathname } = useLocation();
  const onChat = pathname.startsWith('/chat');

  const pending = useMemo(
    () =>
      exchanges.filter(
        (e) =>
          e.kind === 'approval' &&
          e.status === 'running' &&
          // The open chat's panel shows its own requests, and opens for them.
          !(onChat && activeThreadId && e.threadId === activeThreadId),
      ),
    [exchanges, activeThreadId, onChat],
  );

  return (
    <AnimatePresence>
      {pending.map((e) => (
        <Request key={e.id} e={e} />
      ))}
    </AnimatePresence>
  );
}
