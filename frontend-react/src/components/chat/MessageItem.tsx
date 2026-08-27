import { memo, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, FileText, File as FileIcon, Image as ImageIcon, ThumbsUp, ThumbsDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { parseUserAttachments, type DisplayAttachment } from '@/lib/attachmentDisplay';
import { Markdown } from '@/lib/markdown';
import { BubbleTail } from './BubbleTail';
import { ThinkingBlock } from './ThinkingBlock';
import { AskUserCard } from './AskUserCard';
import { VoiceBubble } from './VoiceBubble';
import { useChat, type ChatMessage } from '@/stores/chat';
import { useUI } from '@/stores/ui';
import { useAskUser } from '@/stores/askUser';
import { useT } from '@/lib/i18n';

/**
 * Attached-image thumbnail with click-to-zoom. First click expands the image
 * into a fullscreen lightbox (smooth fade + scale), second click (anywhere)
 * shrinks it back. Escape closes too.
 */
function ZoomableImage({ src, alt }: { src: string; alt: string }) {
  const [open, setOpen] = useState(false);
  // Two-phase mount so the CSS transition actually plays: render the overlay
  // in its "from" state first, then flip to "to" on the next frame.
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => setShown(true));
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setShown(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Unmount the overlay only after the shrink transition finishes.
  const onTransitionEnd = () => {
    if (!shown) setOpen(false);
  };

  return (
    <>
      {/* A real button, not a click handler on an <img>: the thumbnail was not
          focusable and carried no role, so opening an attachment full-size was
          mouse-only. Escape already closed the lightbox; nothing could open it. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`View ${alt || 'image'} full size`}
        className="block cursor-zoom-in rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        <img
          src={src}
          alt={alt}
          loading="lazy"
          className="max-h-52 max-w-full rounded-lg border border-border-subtle object-contain transition-transform duration-200 hover:scale-[1.02]"
        />
      </button>
      {open && (
        <div
          role="button"
          aria-label="Close image preview"
          onClick={() => setShown(false)}
          className={cn(
            'fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm cursor-zoom-out',
            'transition-opacity duration-300 ease-out',
            shown ? 'opacity-100' : 'opacity-0',
          )}
        >
          <img
            src={src}
            alt={alt}
            onTransitionEnd={onTransitionEnd}
            className={cn(
              'max-h-[90vh] max-w-[92vw] rounded-xl object-contain shadow-2xl',
              'transition-transform duration-300 ease-out',
              shown ? 'scale-100' : 'scale-75',
            )}
          />
        </div>
      )}
    </>
  );
}

/** Read-only file chip shown in a sent user message (no remove button). */
function MessageAttachmentChip({ attachment }: { attachment: DisplayAttachment }) {
  const Icon =
    attachment.kind === 'image' ? ImageIcon : attachment.kind === 'binary' ? FileIcon : FileText;
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border-default bg-bg-surface px-2 py-0.5 text-xs text-text-secondary">
      <Icon size={12} className="shrink-0 text-text-muted" />
      <span className="max-w-[160px] truncate">{attachment.name}</span>
    </span>
  );
}

// Memoized: the store rebuilds only the last (streaming) message object each
// token, so completed messages keep their reference and skip the expensive
// markdown re-parse + re-highlight on every streamed token.
export const MessageItem = memo(function MessageItem({ message, streaming = false }: { message: ChatMessage; streaming?: boolean }) {
  const isUser = message.role === 'user';
  const reasoningMode = useUI((s) => s.reasoningMode);
  const t = useT();
  const navigate = useNavigate();

  if (isUser) {
    // Voice message: render the playable audio bubble + transcript instead of
    // the plain text body (the transcript also lives in `content`).
    if (message.voice) {
      return (
        <div className="flex justify-end">
          <VoiceBubble voice={message.voice} pending={message.voicePending} />
        </div>
      );
    }
    const images = message.images ?? [];
    // Pull the inlined attachment blocks back out so we show compact chips
    // ("Cinderpaw.pdf") instead of dumping the whole extracted file content into
    // the bubble. The model still received the full text — this is display
    // only, and works off persisted content so it survives a reload.
    const { attachments, text: visibleText } = parseUserAttachments(message.content);
    // When real pixels are in memory we render thumbnails; the image chips are
    // only the post-reload fallback, so drop them while thumbnails are shown.
    const fileChips =
      images.length > 0 ? attachments.filter((a) => a.kind !== 'image') : attachments;
    return (
      // One rule for the whole transcript: every message says when it was sent.
      // The reply carried a time and the question did not, which read as an
      // oversight because it was one.
      <div className="flex flex-col items-end gap-1">
        {/* The bubble and its tail are one shape in two elements, so they
            share one fill and no border: a stroke would have to be drawn
            around the join as well, and the join is the whole illusion. */}
        {/* Brand fill, not another shade of the background. The first version
            used `bg-bg-elevated`, which on this scene is a step away from the
            page — the bubble was legible only as a faint rectangle and its
            tail not at all. Apple's user bubble is the accent colour for
            exactly this reason: the shape has to read before the tail can
            mean anything. */}
        <div className="relative max-w-[75%] rounded-2xl rounded-br-none px-4 py-2.5 bg-brand text-bg-primary shadow-md">
          <BubbleTail className="absolute right-[-11px] bottom-0 text-brand" />
          {images.length > 0 && (
            <div className={cn('flex flex-wrap gap-2', (visibleText || fileChips.length > 0) && 'mb-2')}>
              {images.map((src, i) => (
                <ZoomableImage key={i} src={src} alt={`Attached image ${i + 1}`} />
              ))}
            </div>
          )}
          {fileChips.length > 0 && (
            <div className={cn('flex flex-wrap gap-1', visibleText && 'mb-2')}>
              {fileChips.map((a, i) => (
                <MessageAttachmentChip key={`${a.name}-${i}`} attachment={a} />
              ))}
            </div>
          )}
          {visibleText && (
            <p className="text-sm whitespace-pre-wrap break-words leading-relaxed">
              {visibleText}
            </p>
          )}
        </div>
        <MessageMeta message={message} />
      </div>
    );
  }

  const showThinking = message.thinking != null && reasoningMode !== 'off';
  const isTruncated = message.truncated === true;
  const askUser = message.askUser;
  const submitAskUser = useAskUser((s) => s.submit);
  const cancelAskUser = useAskUser((s) => s.cancel);

  return (
    <div className="group flex flex-col gap-2">
      {showThinking && (
        <ThinkingBlock
          id={message.id}
          content={message.thinking!}
          duration={message.thinkingDurationMs ? Math.round(message.thinkingDurationMs / 1000) : 0}
          active={!message.thinkingComplete}
        />
      )}
      <div className={cn('text-sm leading-relaxed', !message.content && 'hidden')}>
        <Markdown animateWords={streaming}>{message.content}</Markdown>
      </div>
      {askUser && (
        <AskUserCard
          // Force a fresh component instance per request so internal submit
          // guards / answer slots never leak from a previous question (the
          // ask_user-in-succession hang — see AskUserCard).
          key={askUser.requestId}
          requestId={askUser.requestId}
          questions={askUser.questions}
          answered={askUser.answers}
          onSubmit={(answers) => {
            // The store's submit() resolves the promise that the
            // cinderpawAgentStream manager is awaiting, which is what
            // actually dispatches `cinderpaw_ask_user_response` to Rust.
            // Keep it as the single source of truth for the dispatch.
            submitAskUser(answers);
          }}
          onCancel={() => {
            // Same single-source-of-truth pattern: the store's cancel()
            // rejects the promise; the stream manager catches it and
            // invokes `cinderpaw_ask_user_cancel` for us.
            cancelAskUser('user dismissed');
          }}
        />
      )}
      {isTruncated && (
        <div
          className="flex items-start gap-2 mt-1 px-3 py-2 rounded-md bg-warning/10 border border-warning/30 text-warning"
          role="status"
        >
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <div className="text-xs leading-relaxed">
            <span className="font-medium">{t('chat.truncated.title')}</span>{' '}
            {t('chat.truncated.body')} ({message.truncatedReason ?? 'length'}).
          </div>
        </div>
      )}
      {/* Actions attached by the product (not the model) — currently only the
          zero-model reply, which offers the two real ways forward instead of
          leaving the user at a dead end. */}
      {message.actions && message.actions.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-2">
          {message.actions.map((a) => (
            <button
              key={a.route}
              type="button"
              onClick={() => navigate(a.route)}
              className="px-3 py-1.5 rounded-full border border-border-default bg-bg-surface
                         hover:bg-bg-hover text-sm text-text-secondary transition-colors"
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
      {/* Footer — only on a finished, non-empty reply, and not while a question
          card is pending. The meta is always visible; the thumbs (the
          acceptance adaptation signal) stay hover-only as before. */}
      {!streaming && !askUser && message.content.trim().length > 0 && (
        <div className="flex items-center gap-2">
          <MessageMeta message={message} />
          <FeedbackButtons messageId={message.id} />
        </div>
      )}
    </div>
  );
});

/**
 * The one-line receipt under a finished reply: when it landed, how much it
 * generated, how fast.
 *
 * These four fields have been recorded on every message since the store was
 * written and displayed nowhere, so "what did that turn actually cost me"
 * had no answer short of opening the database.
 *
 * A leading `~` marks a token count we guessed (chars/4) rather than one the
 * provider reported — local models never send usage. The tilde is the whole
 * point of showing the number at all: an estimate that looks measured is
 * worse than no number, because it is the one people quote back at you.
 *
 * ponytail: no money here. Dollars need a per-model price table that goes
 * stale silently, and a stale price is a worse lie than a missing one. Add it
 * when someone owns keeping that table current — see docs/marketing HOOK.md's
 * "$0 per token" claim, which is what this footer proves for local models.
 */
/**
 * "1 scratchpad edit +71" — what the agent wrote in its OWN workspace this turn.
 *
 * Null when it wrote nothing there, which is most turns. A permanent "0 edits"
 * is noise, and noise is how a status line stops being read at all.
 *
 * Removals are dropped when there are none: "+71" is the whole story for an
 * append, while "+71 -0" makes the reader stop and look for a zero that means
 * nothing. Same reason the token count omits `tok/s` when it has none.
 */
export function scratchLabel(
  scratch: { edits: number; added: number; removed: number } | undefined,
): string | null {
  if (!scratch || scratch.edits <= 0) return null;
  const churn = scratch.removed > 0 ? `+${scratch.added} -${scratch.removed}` : `+${scratch.added}`;
  return `${scratch.edits} scratchpad edit${scratch.edits === 1 ? '' : 's'} ${churn}`;
}

function MessageMeta({ message }: { message: ChatMessage }) {
  const at = message.completedAt ?? message.createdAt;
  const parts = [
    new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
  ];
  if (message.tokenCount) {
    parts.push(`${message.tokensEstimated ? '~' : ''}${message.tokenCount.toLocaleString()} tok`);
  }
  if (message.tokensPerSec) parts.push(`${message.tokensPerSec} tok/s`);
  const scratch = scratchLabel(message.scratch);
  if (scratch) parts.push(scratch);
  const fullDate = new Date(at).toLocaleString();
  return (
    <div className="text-xs text-text-muted tabular-nums select-text cursor-text" title={fullDate}>{parts.join(' · ')}</div>
  );
}

/**
 * Thumbs 👍/👎 under an assistant reply. The click forwards to the sidecar's
 * audit log (the §2.10 `acceptance` personal-fitness signal) via the chat
 * store; the highlighted state is in-memory courtesy feedback. Clicking the
 * active vote again toggles it off.
 */
function FeedbackButtons({ messageId }: { messageId: string }) {
  const vote = useChat((s) => s.feedback[messageId]);
  const setFeedback = useChat((s) => s.setFeedback);
  const [toast, setToast] = useState<string | null>(null);
  const handleVote = (v: 'up' | 'down') => {
    const next = vote === v ? null : v;
    // Zustand setFeedback toggles off when same vote clicked again — pass undefined to clear
    // The store's setFeedback expects 'up' | 'down', but toggle-off is done by clicking same again
    // We mimic by passing the opposite then clearing? Simpler: just call with v and let store toggle
    setFeedback(messageId, v as any);
    const msg = next ? (v === 'up' ? 'Thanks!' : 'Noted') : 'Removed';
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
  };
  return (
    <div className="flex items-center gap-2 mt-0.5 -ml-1">
      <div className="flex items-center gap-1 opacity-60 hover:opacity-100 focus-within:opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100 transition-opacity">
        <button
          type="button"
          aria-label="Good response"
          aria-pressed={vote === 'up'}
          onClick={() => handleVote('up')}
          className={cn(
            'p-1 rounded hover:bg-bg-hover transition-colors',
            vote === 'up' ? 'text-brand' : 'text-text-muted hover:text-text-secondary',
          )}
        >
          <ThumbsUp size={13} />
        </button>
        <button
          type="button"
          aria-label="Bad response"
          aria-pressed={vote === 'down'}
          onClick={() => handleVote('down')}
          className={cn(
            'p-1 rounded hover:bg-bg-hover transition-colors',
            vote === 'down' ? 'text-error' : 'text-text-muted hover:text-text-secondary',
          )}
        >
          <ThumbsDown size={13} />
        </button>
      </div>
      {toast && (
        <span className="text-2xs text-text-secondary bg-bg-elevated border border-border-subtle rounded-full px-2 py-0.5 animate-in fade-in">
          {toast}
        </span>
      )}
    </div>
  );
}
