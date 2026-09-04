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
    // No `scroll-smooth` on the container: the autoscroll effect sets
    // scrollTop on every streamed frame, and CSS smooth scrolling turns each
    // of those into an overlapping animation — visible jank on long chats.
    <div ref={containerRef} className="h-full overflow-y-auto thin-scrollbar relative">
      <div className="max-w-3xl mx-auto px-6 py-6 pb-48 space-y-6">
        {messages.map((m, i) => (
          // A message arrives, it does not blink into existence. 200ms and two
          // pixels of travel is the whole effect — enough for the eye to see
          // WHERE the new thing came from, short enough that nobody waits for
          // it. Keyed on the message id so only genuinely new rows animate;
          // re-rendering a streamed token must never replay it.
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
      {!isAtBottom && (
        <button
          type="button"
          onClick={jumpToBottom}
          className="absolute bottom-20 left-1/2 -translate-x-1/2 z-10 rounded-full bg-brand text-white text-xs px-3 py-1.5 shadow-lg hover:bg-brand-hover flex items-center gap-1.5 cursor-pointer border border-brand-hover"
        >
          ↓ {newCount > 0 ? `${newCount} new` : 'Jump to bottom'}
        </button>
      )}
    </div>
  );
}
