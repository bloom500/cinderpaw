import { memo, useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Markdown } from '@/lib/markdown';
import { ThinkingBlock } from './ThinkingBlock';
import { AskUserCard } from './AskUserCard';
import type { ChatMessage } from '@/stores/chat';
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

// Memoized: the store rebuilds only the last (streaming) message object each
// token, so completed messages keep their reference and skip the expensive
// markdown re-parse + re-highlight on every streamed token.
export const MessageItem = memo(function MessageItem({ message, streaming = false }: { message: ChatMessage; streaming?: boolean }) {
  const isUser = message.role === 'user';
  const reasoningMode = useUI((s) => s.reasoningMode);
  const t = useT();

  if (isUser) {
    const images = message.images ?? [];
    // The "[Image attached: name]" note exists for the MODEL's benefit (and
    // as a fallback after reload, when data URLs are no longer in memory).
    // While the pixels are available we show real thumbnails instead, so the
    // note lines are stripped from the visible text.
    const visibleText =
      images.length > 0
        ? message.content.replace(/^\[Image attached: [^\]]*\]\s*$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
        : message.content;
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] rounded-2xl rounded-tr-sm px-4 py-3 bg-bg-elevated border border-border-default">
          {images.length > 0 && (
            <div className={cn('flex flex-wrap gap-2', visibleText && 'mb-2')}>
              {images.map((src, i) => (
                <ZoomableImage key={i} src={src} alt={`Attached image ${i + 1}`} />
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
    <div className="flex flex-col gap-2">
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
            {t('chat.truncated.body')} ({message.truncatedReason ?? 'length'}).{' '}
            {t('chat.truncated.hint.pre')} <code className="px-1 py-0.5 rounded bg-amber-500/15 font-mono text-[11px]">max_tokens</code>{' '}
            {t('chat.truncated.hint.post')}
          </div>
        </div>
      )}
    </div>
  );
});
