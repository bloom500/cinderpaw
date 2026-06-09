import { memo } from 'react';
import { AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Markdown } from '@/lib/markdown';
import { ThinkingBlock } from './ThinkingBlock';
import { AskUserCard } from './AskUserCard';
import type { ChatMessage } from '@/stores/chat';
import { useUI } from '@/stores/ui';
import { useAskUser } from '@/stores/askUser';

// Memoized: the store rebuilds only the last (streaming) message object each
// token, so completed messages keep their reference and skip the expensive
// markdown re-parse + re-highlight on every streamed token.
export const MessageItem = memo(function MessageItem({ message, streaming = false }: { message: ChatMessage; streaming?: boolean }) {
  const isUser = message.role === 'user';
  const reasoningMode = useUI((s) => s.reasoningMode);

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
            <span className="font-medium">Răspuns trunchiat.</span>{' '}
            Modelul a atins limita de tokeni înainte să termine ({message.truncatedReason ?? 'length'}).
            Mărește <code className="px-1 py-0.5 rounded bg-amber-500/15 font-mono text-[11px]">max_tokens</code>{' '}
            în Settings pentru răspunsuri mai lungi.
          </div>
        </div>
      )}
    </div>
  );
});
