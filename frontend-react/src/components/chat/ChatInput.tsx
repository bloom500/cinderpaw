import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Paperclip, Wrench, Brain, ArrowUp, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ModelSelector } from './ModelSelector';
import { useModel } from '@/stores/model';
import { useChat } from '@/stores/chat';
import { useSendMessage } from '@/hooks/useSendMessage';
import { tauri } from '@/lib/tauri';

// Mobile UX (deferred): swap to Enter=newline + explicit send button.
export function ChatInput() {
  const [text, setText] = useState('');
  const loaded = useModel((s) => s.loaded);
  const status = useChat((s) => s.streamStatus);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const send = useSendMessage();

  // Auto-resize textarea
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [text]);

  const isStreaming = status === 'streaming';
  const disabled = !loaded;

  const trySend = async () => {
    if (!text.trim() || isStreaming || disabled) return;
    const content = text;
    setText('');
    await send(content);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void trySend();
    }
  };

  return (
    <TooltipProvider delayDuration={300}>
      <div className="border-t border-border-subtle bg-bg-primary px-4 py-3">
        <div className="rounded-xl border border-border-default bg-bg-surface focus-within:border-brand transition-colors">
          <Textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={loaded ? 'Ask anything…' : 'Load a model to start chatting'}
            disabled={disabled}
            rows={1}
            className="resize-none border-0 bg-transparent focus-visible:ring-0 max-h-[200px]"
          />
          <div className="flex items-center justify-between px-2 pb-2">
            <div className="flex gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    disabled
                    className="p-1.5 rounded text-text-muted opacity-60 cursor-not-allowed"
                    aria-label="Attach file"
                  >
                    <Paperclip size={16} />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Coming soon</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    disabled
                    className="p-1.5 rounded text-text-muted opacity-60 cursor-not-allowed"
                    aria-label="Tools"
                  >
                    <Wrench size={16} />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Coming soon</TooltipContent>
              </Tooltip>
              <button
                type="button"
                className="p-1.5 rounded text-text-muted hover:bg-bg-hover hover:text-text-secondary"
                aria-label="Reasoning toggle"
              >
                <Brain size={16} />
              </button>
            </div>
            <div className="flex items-center gap-2">
              <ModelSelector />
              {isStreaming ? (
                <Button
                  size="icon"
                  variant="destructive"
                  onClick={() => void tauri.chat.stop()}
                  aria-label="Stop"
                  className="h-7 w-7"
                >
                  <Square size={12} />
                </Button>
              ) : (
                <Button
                  size="icon"
                  onClick={() => void trySend()}
                  disabled={!text.trim() || disabled}
                  aria-label="Send"
                  className="h-7 w-7"
                >
                  <ArrowUp size={12} />
                </Button>
              )}
            </div>
          </div>
        </div>
        {!loaded && (
          <p className="text-xs text-text-muted mt-2">
            No model loaded. Open Models to load one.
          </p>
        )}
      </div>
    </TooltipProvider>
  );
}
