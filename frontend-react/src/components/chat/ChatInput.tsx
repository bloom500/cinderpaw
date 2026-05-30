import { useEffect, useRef, useState, forwardRef, useImperativeHandle, type KeyboardEvent } from 'react';
import { Brain, ArrowUp, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ModelSelector } from './ModelSelector';
import { AttachedFileChip, type AttachedFile } from './AttachedFileChip';
import { FileAttachButton } from './FileAttachButton';
import { ToolsPopover } from './ToolsPopover';
import { useModel } from '@/stores/model';
import { useChat } from '@/stores/chat';
import { useUI, type ReasoningMode } from '@/stores/ui';
import { useSendMessage } from '@/hooks/useSendMessage';
import { tauri } from '@/lib/tauri';
import { cn } from '@/lib/utils';

const REASONING_CONFIG: Record<ReasoningMode, {
  label: string;
  iconClass: string;
  badgeClass: string;
  dot: string;
  description: string;
}> = {
  auto: { label: 'A',   iconClass: 'text-sky-400',     badgeClass: 'bg-gray-500/20 text-gray-400',      dot: 'bg-sky-400',     description: 'Auto — detect from model name' },
  on:   { label: 'ON',  iconClass: 'text-emerald-400', badgeClass: 'bg-emerald-500/20 text-emerald-400', dot: 'bg-emerald-400', description: 'On — always enable thinking' },
  off:  { label: 'OFF', iconClass: 'text-rose-400',    badgeClass: 'bg-rose-500/20 text-rose-400',       dot: 'bg-rose-400',    description: 'Off — suppress thinking blocks' },
};

export interface ChatInputHandle {
  setText: (text: string) => void;
  focus: () => void;
}

// Mobile UX (deferred): swap to Enter=newline + explicit send button.
export const ChatInput = forwardRef<ChatInputHandle, { isEmpty?: boolean }>(function ChatInput({ isEmpty }, ref) {
  const [text, setText] = useState('');
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const loaded      = useModel((s) => s.loaded);
  const cloudModel  = useModel((s) => s.cloudModel);
  const status = useChat((s) => s.streamStatus);
  const reasoningMode = useUI((s) => s.reasoningMode);
  const setReasoningMode = useUI((s) => s.setReasoningMode);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const send = useSendMessage();

  useImperativeHandle(ref, () => ({
    setText: (t: string) => {
      setText(t);
      setTimeout(() => taRef.current?.focus(), 0);
    },
    focus: () => taRef.current?.focus(),
  }));

  // Auto-resize textarea
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [text]);

  const isStreaming = status === 'streaming';
  const disabled = !loaded && !cloudModel;

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
      <div className={cn(
        isEmpty
          ? 'px-4 py-3 max-w-2xl mx-auto w-full'
          : 'border-t border-border-subtle bg-bg-primary px-4 py-3',
      )}>
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
            placeholder={!disabled ? 'Ask anything…' : 'Load a model or add a cloud key to start chatting'}
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
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
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
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="start" className="w-52">
                  <DropdownMenuLabel className="text-xs text-text-muted">Reasoning mode</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuRadioGroup
                    value={reasoningMode}
                    onValueChange={(v) => setReasoningMode(v as ReasoningMode)}
                  >
                    {(Object.entries(REASONING_CONFIG) as [ReasoningMode, typeof REASONING_CONFIG[ReasoningMode]][]).map(([mode, cfg]) => (
                      <DropdownMenuRadioItem key={mode} value={mode} className="gap-2 text-sm">
                        <span className={cn('h-2 w-2 rounded-full shrink-0', cfg.dot)} />
                        <span>{cfg.description}</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
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
        {disabled && !isEmpty && (
          <p className="text-xs text-text-muted mt-2">
            No model loaded. Open Models to download one, or add a cloud key in Settings.
          </p>
        )}
      </div>
    </TooltipProvider>
  );
});
