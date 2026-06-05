import { useEffect, useRef } from 'react';
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

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      const threshold = 40;
      isAtBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (el && isAtBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  // Virtualization deferred. Add react-virtuoso if profiling shows scroll jank
  // or messages.length > 500 routinely. See spec §4.5.
  return (
    <div ref={containerRef} className="h-full overflow-y-auto scroll-smooth scrollbar-hide">
      <div className="max-w-3xl mx-auto px-6 py-6 pb-48 space-y-6">
        {messages.map((m, i) => (
          <MessageItem
            key={m.id}
            message={m}
            streaming={status === 'streaming' && i === messages.length - 1 && m.role === 'assistant'}
          />
        ))}
        {status === 'streaming' && messages[messages.length - 1]?.content === '' && (
          <StreamingIndicator phase={agentPhase ?? 'thinking'} tool={agentTool} />
        )}
      </div>
    </div>
  );
}
