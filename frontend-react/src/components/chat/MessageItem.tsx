import { cn } from '@/lib/utils';
import { Markdown } from '@/lib/markdown';
import { ThinkingBlock } from './ThinkingBlock';
import type { ChatMessage } from '@/stores/chat';

export function MessageItem({ message }: { message: ChatMessage }) {
  return (
    <div className={cn('rounded-lg px-4 py-3', message.role === 'user' && 'bg-bg-surface')}>
      <div className="text-xs font-medium text-text-muted mb-2">
        {message.role === 'user' ? 'You' : 'Assistant'}
      </div>
      {message.thinking != null && (
        <ThinkingBlock
          id={message.id}
          content={message.thinking}
          duration={message.thinkingDurationMs ? Math.round(message.thinkingDurationMs / 1000) : 0}
          active={!message.thinkingComplete}
        />
      )}
      <Markdown>{message.content}</Markdown>
    </div>
  );
}
