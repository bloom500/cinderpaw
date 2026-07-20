import { memo, useEffect, useState } from 'react';
import { AlertTriangle, FileText, File as FileIcon, Image as ImageIcon, ThumbsUp, ThumbsDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { parseUserAttachments, type DisplayAttachment } from '@/lib/attachmentDisplay';
import { Markdown } from '@/lib/markdown';
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
      <img
        src={src}
        alt={alt}
        loading="lazy"
        onClick={() => setOpen(true)}
        className="max-h-52 max-w-full rounded-lg border border-border-subtle object-contain cursor-zoom-in transition-transform duration-200 hover:scale-[1.02]"
      />
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
    // ("Feral.pdf") instead of dumping the whole extracted file content into
    // the bubble. The model still received the full text — this is display
    // only, and works off persisted content so it survives a reload.
    const { attachments, text: visibleText } = parseUserAttachments(message.content);
    // When real pixels are in memory we render thumbnails; the image chips are
    // only the post-reload fallback, so drop them while thumbnails are shown.
    const fileChips =
      images.length > 0 ? attachments.filter((a) => a.kind !== 'image') : attachments;
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] rounded-2xl rounded-tr-sm px-4 py-3 bg-bg-elevated border border-border-default">
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
            <p className="text-sm text-text-primary whitespace-pre-wrap break-words leading-relaxed">
              {visibleText}
            </p>
          )}
        </div>
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
            // feralAgentStream manager is awaiting, which is what
            // actually dispatches `feral_ask_user_response` to Rust.
            // Keep it as the single source of truth for the dispatch.
            submitAskUser(answers);
          }}
          onCancel={() => {
            // Same single-source-of-truth pattern: the store's cancel()
            // rejects the promise; the stream manager catches it and
            // invokes `feral_ask_user_cancel` for us.
            cancelAskUser('user dismissed');
          }}
        />
      )}
      {isTruncated && (
        <div
          className="flex items-start gap-2 mt-1 px-3 py-2 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-600 dark:text-amber-400"
          role="status"
        >
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <div className="text-xs leading-relaxed">
            <span className="font-medium">{t('chat.truncated.title')}</span>{' '}
            {t('chat.truncated.body')} ({message.truncatedReason ?? 'length'}).
          </div>
        </div>
      )}
      {/* Thumbs feedback — only on a finished, non-empty reply, and not while a
          question card is pending. Feeds the acceptance adaptation signal. */}
      {!streaming && !askUser && message.content.trim().length > 0 && (
        <FeedbackButtons messageId={message.id} />
      )}
    </div>
  );
});

/**
 * Thumbs 👍/👎 under an assistant reply. The click forwards to the sidecar's
 * audit log (the §2.10 `acceptance` personal-fitness signal) via the chat
 * store; the highlighted state is in-memory courtesy feedback. Clicking the
 * active vote again toggles it off.
 */
function FeedbackButtons({ messageId }: { messageId: string }) {
  const vote = useChat((s) => s.feedback[messageId]);
  const setFeedback = useChat((s) => s.setFeedback);
  return (
    <div className="flex items-center gap-1 mt-0.5 -ml-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
      <button
        type="button"
        aria-label="Good response"
        aria-pressed={vote === 'up'}
        onClick={() => setFeedback(messageId, 'up')}
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
        onClick={() => setFeedback(messageId, 'down')}
        className={cn(
          'p-1 rounded hover:bg-bg-hover transition-colors',
          vote === 'down' ? 'text-error' : 'text-text-muted hover:text-text-secondary',
        )}
      >
        <ThumbsDown size={13} />
      </button>
    </div>
  );
}
