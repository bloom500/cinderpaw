import { cn } from '@/lib/utils';
import { Markdown } from '@/lib/markdown';
import { ThinkingBlock } from './ThinkingBlock';
import type { ChatMessage } from '@/stores/chat';

export function MessageItem({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] rounded-2xl rounded-tr-sm px-4 py-3 bg-bg-elevated border border-border-default">
          <p className="text-sm text-text-primary whitespace-pre-wrap break-words leading-relaxed">
            {message.content}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {message.thinking != null && (
        <ThinkingBlock
          id={message.id}
          content={message.thinking}
          duration={message.thinkingDurationMs ? Math.round(message.thinkingDurationMs / 1000) : 0}
          active={!message.thinkingComplete}
        />
      )}
      <div className={cn('text-sm leading-relaxed', !message.content && 'hidden')}>
        <Markdown>{message.content}</Markdown>
      </div>
    </div>
  );
}
