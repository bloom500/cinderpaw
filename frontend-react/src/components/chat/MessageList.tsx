import { useEffect, useRef, useState } from 'react';
import { useChat } from '@/stores/chat';
import { MessageItem } from './MessageItem';
import { StreamingIndicator } from './StreamingIndicator';

export function MessageList() {
  const messages = useChat((s) => s.messages);
  const status = useChat((s) => s.streamStatus);
  const agentPhase = useChat((s) => s.agentPhase);
  const agentTool = useChat((s) => s.agentTool);
  const containerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const prevLenRef = useRef(messages.length);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      isAtBottomRef.current = atBottom;
      setIsAtBottom(atBottom);
      if (atBottom) setNewCount(0);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    const prevLen = prevLenRef.current;
    const delta = messages.length - prevLen;
    if (delta > 0 && !isAtBottomRef.current) {
      setNewCount((n) => n + delta);
    }
    if (el && isAtBottomRef.current) el.scrollTop = el.scrollHeight;
    prevLenRef.current = messages.length;
  }, [messages, status]);

  const jumpToBottom = () => {
    const el = containerRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      setNewCount(0);
      setIsAtBottom(true);
      isAtBottomRef.current = true;
    }
  };

  // Virtualization deferred. Add react-virtuoso if profiling shows scroll jank
  // or messages.length > 500 routinely. See spec §4.5.
  return (
    // The wrapper is the positioning context, and it is deliberately NOT the
    // element that scrolls.
    //
    // "Jump to bottom" used to be an absolute child of the scroller itself. An
    // absolutely positioned child of a scroll container is laid out against the
    // scrolled CONTENT, not against the part of it you can see, so the button
    // sat 80px above the end of the transcript and rode up and out of view with
    // everything else. It was on screen only when you were already at the
    // bottom, which is the one moment it is not wanted. Splitting the scroller
    // out into its own child is what pins the button to the visible area.
    <div className="h-full relative">
      {/* No `scroll-smooth` on the scroller: the autoscroll effect sets
          scrollTop on every streamed frame, and CSS smooth scrolling turns each
          of those into an overlapping animation — visible jank on long chats. */}
      <div ref={containerRef} className="h-full overflow-y-auto thin-scrollbar">
        <div className="max-w-3xl mx-auto px-6 py-6 pb-48 space-y-6">
          {messages.map((m, i) => (
            // A message arrives, it does not blink into existence. 200ms and
            // two pixels of travel is the whole effect — enough for the eye to
            // see WHERE the new thing came from, short enough that nobody waits
            // for it. Keyed on the message id so only genuinely new rows
            // animate; re-rendering a streamed token must never replay it.
            <div key={m.id} className="animate-in fade-in-0 slide-in-from-bottom-2 duration-200">
              <MessageItem
                message={m}
                streaming={status === 'streaming' && i === messages.length - 1 && m.role === 'assistant'}
              />
            </div>
          ))}
          {(() => {
            const last = messages[messages.length - 1];
            const hasActiveThinking = Boolean(last?.thinking && !last.thinkingComplete);
            return status === 'streaming' && last?.content === '' && !hasActiveThinking ? (
              <StreamingIndicator phase={agentPhase ?? 'thinking'} tool={agentTool} />
            ) : null;
          })()}
        </div>
      </div>
      {!isAtBottom && (
        <button
          type="button"
          onClick={jumpToBottom}
          // The offset is the composer's MEASURED height plus a gap, published
          // as `--chat-dock-h` by ChatPage. The old value was `bottom-20`, a
          // flat 80px, which was only ever right for a one-line draft: type
          // three lines, or attach a file, and the composer grew up over the
          // button. The fallback matches a resting single-line composer, for
          // any host that renders this list without the chat page around it.
          style={{ bottom: 'calc(var(--chat-dock-h, 5rem) + 0.75rem)' }}
          className="absolute left-1/2 -translate-x-1/2 z-10 rounded-full bg-brand text-white text-xs px-3 py-1.5 shadow-lg hover:bg-brand-hover flex items-center gap-1.5 cursor-pointer border border-brand-hover"
        >
          ↓ {newCount > 0 ? `${newCount} new` : 'Jump to bottom'}
        </button>
      )}
    </div>
  );
}
