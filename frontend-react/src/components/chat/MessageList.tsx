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

  /**
   * How tall the composer is right now.
   *
   * The jump button has to sit just above it, and "just above it" is not a
   * constant: the field grows a line as you type, and the mascot perches on
   * its top edge. A hardcoded offset is wrong the first time somebody writes a
   * paragraph, so the dock is measured instead — and re-measured when it
   * resizes, which is the only way this stays true.
   */
  const [dockH, setDockH] = useState(96);
  useEffect(() => {
    const dock = document.querySelector('[data-chat-input-dock]');
    if (!dock) return;
    const measure = () => setDockH(dock.getBoundingClientRect().height);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(dock);
    return () => ro.disconnect();
  }, []);

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
    // Two elements, and the split is the fix for the jump button.
    //
    // The button used to live INSIDE the scroller, positioned `absolute
    // bottom-20`. Absolute positioning inside a scrolling box is relative to
    // that box's CONTENT, not to what you can see — so the button travelled
    // with the text and turned up halfway down the screen, wherever the reader
    // happened to be. It has to hang off something that does not scroll.
    <div className="relative h-full">
    <div ref={containerRef} className="h-full overflow-y-auto thin-scrollbar">
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
    </div>
      {!isAtBottom && (
        <button
          type="button"
          onClick={jumpToBottom}
          // Sits on the composer's own top edge, measured, plus 12px of air.
          style={{ bottom: dockH + 12 }}
          className="absolute left-1/2 -translate-x-1/2 z-10 rounded-full bg-brand text-white text-xs px-3 py-1.5 shadow-lg hover:bg-brand-hover flex items-center gap-1.5 cursor-pointer border border-brand-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          ↓ {newCount > 0 ? `${newCount} new` : 'Jump to bottom'}
        </button>
      )}
    </div>
  );
}
