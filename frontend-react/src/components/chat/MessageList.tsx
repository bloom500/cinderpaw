import { useEffect, useRef, useState } from 'react';
import {
  MessageScroller,
  useMessageScrollerScrollable,
} from '@shadcn/react/message-scroller';
import { useChat } from '@/stores/chat';
import { cn } from '@/lib/utils';
import { MessageItem } from './MessageItem';
import { useResendTurn } from '@/hooks/useResendTurn';
import { StreamingIndicator } from './StreamingIndicator';

/**
 * The transcript, on shadcn's MessageScroller.
 *
 * The hand-rolled version followed the bottom on every frame, so a long reply
 * pushed your own question off the top while you were still reading the start
 * of the answer. The scroller anchors each of YOUR turns near the top and lets
 * the reply stream into the room below it; it follows the bottom only while you
 * are at the bottom, and a wheel, key or touch that moves away stops the follow.
 * Opening a saved chat lands on its latest turn.
 */
export function MessageList() {
  const messages = useChat((s) => s.messages);
  // Rows that arrive together (a chat opened, history loaded) are already
  // there; only the one or two a turn adds should arrive. Animating fifty rows
  // at once on open cost frames and says nothing. Refs written during render:
  // idempotent, so a second StrictMode render changes nothing.
  const known = useRef(new Set<string>());
  const quiet = useRef(new Set<string>());
  const unseen = messages.filter((m) => !known.current.has(m.id));
  if (unseen.length > 2) for (const m of unseen) quiet.current.add(m.id);
  for (const m of unseen) known.current.add(m.id);
  // One resend for the whole transcript: the hooks it needs are called here,
  // once, not inside every row.
  const resend = useResendTurn();
  const status = useChat((s) => s.streamStatus);
  const agentPhase = useChat((s) => s.agentPhase);
  const agentTool = useChat((s) => s.agentTool);

  const last = messages[messages.length - 1];
  const hasActiveThinking = Boolean(last?.thinking && !last.thinkingComplete);
  const waitingForFirstToken = status === 'streaming' && last?.content === '' && !hasActiveThinking;

  return (
    <MessageScroller.Provider autoScroll defaultScrollPosition="last-anchor">
      {/* The root is the positioning context and is NOT the element that
          scrolls: an absolute child of a scroll container is laid out against
          the scrolled content, so "Jump to bottom" used to ride up and out of
          view with the transcript. */}
      <MessageScroller.Root className="h-full relative">
        {/* No `scroll-smooth`: programmatic follow on every streamed frame
            turns into overlapping animations, visible jank on long chats. */}
        <MessageScroller.Viewport aria-label="Conversation" className="h-full overflow-y-auto overscroll-contain thin-scrollbar outline-hidden">
          {/* Clears the dock's measured height, not a flat 12rem: the dock grows
              with the workers card, the error notice and a multi-line draft,
              and a flat pad let the last reply slide under it. */}
          <MessageScroller.Content
            className="max-w-3xl mx-auto px-6 py-6 flex flex-col gap-6"
            style={{ paddingBottom: 'calc(var(--chat-dock-h, 10rem) + 2rem)' }}
          >
            {messages.map((m, i) => (
              // A message arrives, it does not blink into existence. Keyed on
              // the id so only genuinely new rows animate; a streamed token must
              // never replay it.
              <MessageScroller.Item
                key={m.id}
                messageId={m.id}
                scrollAnchor={m.role === 'user'}
                className={cn(
                  'message-row',
                  !quiet.current.has(m.id) && (m.role === 'user'
                    // Yours rises out of the composer's corner: it came from there.
                    ? 'animate-in fade-in-0 slide-in-from-bottom-4 zoom-in-95 origin-bottom-right duration-300'
                    : 'animate-in fade-in-0 slide-in-from-bottom-2 duration-200'),
                )}
              >
                <MessageItem
                  message={m}
                  streaming={status === 'streaming' && i === messages.length - 1 && m.role === 'assistant'}
                  // Retry under a reply resends the question above it; Send under
                  // an edited question resends that one. Both drop everything
                  // below, which is why they are off while a reply is arriving.
                  onRetry={
                    status === 'streaming' || m.role !== 'assistant' || i === 0
                      ? undefined
                      : () => void resend(i - 1)
                  }
                  onEdit={
                    status === 'streaming' || m.role !== 'user'
                      ? undefined
                      : (text) => void resend(i, text)
                  }
                />
              </MessageScroller.Item>
            ))}
            {waitingForFirstToken && <StreamingIndicator phase={agentPhase ?? 'thinking'} tool={agentTool} />}
          </MessageScroller.Content>
        </MessageScroller.Viewport>
        <JumpToBottom count={messages.length} />
      </MessageScroller.Root>
    </MessageScroller.Provider>
  );
}

/**
 * Shown only while there is transcript below the fold, with how many messages
 * arrived while you were up there. Offset by the composer's MEASURED height
 * (`--chat-dock-h`, published by ChatPage): a flat 80px was right for a
 * one-line draft and hidden behind a three-line one.
 */
function JumpToBottom({ count }: { count: number }) {
  const { end: below } = useMessageScrollerScrollable();
  const seen = useRef(count);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (!below) {
      seen.current = count;
      setUnread(0);
    } else if (count > seen.current) {
      setUnread(count - seen.current);
    }
  }, [below, count]);

  return (
    <MessageScroller.Button
      direction="end"
      render={(props, state) =>
        state.active ? (
          <button
            {...props}
            style={{ bottom: 'calc(var(--chat-dock-h, 5rem) + 0.75rem)' }}
            className="absolute left-1/2 -translate-x-1/2 z-10 rounded-full bg-(--surface-typing) text-text-primary text-xs px-3 py-1.5 shadow-sm hover:bg-bg-hover flex items-center gap-1.5 border border-border-default"
          >
            ↓ {unread > 0 ? `${unread} new` : 'Jump to bottom'}
          </button>
        ) : null
      }
    />
  );
}
