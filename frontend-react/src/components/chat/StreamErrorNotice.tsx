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
import { useSendMessage } from '@/hooks/useSendMessage';
import type { AttachedFile } from '@/components/chat/AttachedFileChip';

const IMAGE_NOTE_RE = /^\[Image attached: ([^\]]*)\]\s*$/gm;

export function StreamErrorNotice() {
  const status = useChat((s) => s.streamStatus);
  const raw = useChat((s) => s.streamError);
  const navigate = useNavigate();
  const sendMessage = useSendMessage();
  const [showDetail, setShowDetail] = useState(false);

  if (status !== 'error' || !raw) return null;
  const err = humanizeError(raw);

  // Resend the last user turn: drop the failed assistant message and the user
  // message that triggered it, then send the same content again. Image
  // attachments are rebuilt from the message's in-memory data URLs; their
  // "[Image attached: …]" note lines are stripped from the text because
  // buildUserContent regenerates them from the files array.
  const retry = () => {
    const { messages } = useChat.getState();
    let i = messages.length - 1;
    while (i >= 0 && messages[i].role !== 'user') i--;
    if (i < 0) return;
    const user = messages[i];

    const images = user.images ?? [];
    const names = [...user.content.matchAll(IMAGE_NOTE_RE)].map((m) => m[1]);
    const files: AttachedFile[] = images.map((dataUrl, n) => ({
      name: names[n] ?? `image-${n + 1}.png`,
      path: `retry://${n}`,
      content: null,
      kind: 'image',
      dataUrl,
    }));
    const text =
      images.length > 0
        ? user.content.replace(IMAGE_NOTE_RE, '').replace(/\n{3,}/g, '\n\n').trim()
        : user.content;

    useChat.setState({
      messages: messages.slice(0, i),
      streamStatus: 'idle',
      streamError: null,
    });
    void sendMessage(text, files);
  };

  return (
    <div
      role="alert"
      className="mx-auto max-w-2xl w-full px-4 pb-2"
    >
      <div className="flex items-start gap-2.5 rounded-xl border border-rose-500/30 bg-rose-500/5 px-4 py-3">
        <AlertCircle size={16} className="text-rose-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0 space-y-1.5">
          <p className="text-sm text-text-primary leading-relaxed">{err.message}</p>
          {err.detail && err.detail !== err.message && (
            <button
              type="button"
              onClick={() => setShowDetail((v) => !v)}
              className="flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary"
            >
              {showDetail ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              Technical details
            </button>
          )}
          {showDetail && (
            <pre className="text-xs text-text-muted bg-bg-surface border border-border-subtle rounded px-2 py-1.5 max-h-28 overflow-auto whitespace-pre-wrap break-words">
              {err.detail}
            </pre>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button size="sm" variant="outline" onClick={retry}>
            <RotateCcw size={13} className="mr-1.5" />
            Retry
          </Button>
          {err.action && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigate(err.action === 'settings' ? '/settings' : '/models')}
            >
              {err.actionLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
