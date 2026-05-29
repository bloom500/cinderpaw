import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Brain, ArrowUp, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ModelSelector } from './ModelSelector';
import { AttachedFileChip, type AttachedFile } from './AttachedFileChip';
import { FileAttachButton } from './FileAttachButton';
import { ToolsPopover } from './ToolsPopover';
import { useModel } from '@/stores/model';
import { useChat } from '@/stores/chat';
import { useUI } from '@/stores/ui';
import { useSendMessage } from '@/hooks/useSendMessage';
import { tauri } from '@/lib/tauri';
import { cn } from '@/lib/utils';

const REASONING_CONFIG = {
  auto: { label: 'A',   iconClass: 'text-sky-400',     badgeClass: 'bg-gray-500/20 text-gray-400' },
  on:   { label: 'ON',  iconClass: 'text-emerald-400', badgeClass: 'bg-emerald-500/20 text-emerald-400' },
  off:  { label: 'OFF', iconClass: 'text-rose-400',    badgeClass: 'bg-rose-500/20 text-rose-400' },
} as const;

// Mobile UX (deferred): swap to Enter=newline + explicit send button.
export function ChatInput() {
  const [text, setText] = useState('');
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const loaded = useModel((s) => s.loaded);
  const status = useChat((s) => s.streamStatus);
  const reasoningMode = useUI((s) => s.reasoningMode);
  const cycleReasoningMode = useUI((s) => s.cycleReasoningMode);
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
    const files = attachedFiles;
    setText('');
    setAttachedFiles([]);
    await send(content, files);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void trySend();
    }
  };

  const removeFile = (path: string) =>
    setAttachedFiles((prev) => prev.filter((f) => f.path !== path));

  const rc = REASONING_CONFIG[reasoningMode];

  return (
    <TooltipProvider delayDuration={300}>
      <div className="border-t border-border-subtle bg-bg-primary px-4 py-3">
        <div className="rounded-xl border border-border-default bg-bg-surface focus-within:border-brand transition-colors">
          {attachedFiles.length > 0 && (
            <div className="flex flex-wrap gap-1 px-3 pt-2">
              {attachedFiles.map((f) => (
                <AttachedFileChip
                  key={f.path}
                  file={f}
                  onRemove={() => removeFile(f.path)}
                />
              ))}
            </div>
          )}
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
              <FileAttachButton
                onFilesSelected={(files) =>
                  setAttachedFiles((prev) => {
                    const existing = new Set(prev.map((f) => f.path));
                    return [...prev, ...files.filter((f) => !existing.has(f.path))];
                  })
                }
              />
              <ToolsPopover />
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={cycleReasoningMode}
                    className={cn('relative p-1.5 rounded hover:bg-bg-hover', rc.iconClass)}
                    aria-label={`Reasoning: ${reasoningMode}`}
                  >
                    <Brain size={16} />
                    <span
                      className={cn(
                        'absolute -bottom-0.5 -right-0.5 rounded px-[3px] text-[8px] font-bold leading-[11px]',
                        rc.badgeClass,
                      )}
                    >
                      {rc.label}
                    </span>
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  Reasoning: {reasoningMode === 'auto' ? 'Auto (detect from model)' : reasoningMode === 'on' ? 'Always on' : 'Off'}
                </TooltipContent>
              </Tooltip>
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
