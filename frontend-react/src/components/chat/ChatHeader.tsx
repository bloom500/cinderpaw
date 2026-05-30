import { Minus, Square, X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useConversations } from '@/stores/conversations';
import { ModelPill } from './ModelPill';
import { cn } from '@/lib/utils';

function WinControls() {
  return (
    <div className="flex items-center shrink-0">
      <button
        type="button"
        onClick={() => void getCurrentWindow().minimize()}
        className="h-8 w-10 flex items-center justify-center text-text-muted/40 hover:text-text-muted hover:bg-white/5 transition-colors"
        aria-label="Minimize"
      >
        <Minus size={13} strokeWidth={1.5} />
      </button>
      <button
        type="button"
        onClick={() => void getCurrentWindow().toggleMaximize()}
        className="h-8 w-10 flex items-center justify-center text-text-muted/40 hover:text-text-muted hover:bg-white/5 transition-colors"
        aria-label="Maximize"
      >
        <Square size={11} strokeWidth={1.5} />
      </button>
      <button
        type="button"
        onClick={() => void getCurrentWindow().close()}
        className={cn(
          'h-8 w-10 flex items-center justify-center text-text-muted/40 transition-colors',
          'hover:text-white hover:bg-red-500/80',
        )}
        aria-label="Close"
      >
        <X size={13} strokeWidth={1.5} />
      </button>
    </div>
  );
}

export function ChatHeader() {
  const currentId = useConversations((s) => s.currentId);
  const list      = useConversations((s) => s.list);
  const current   = list?.find((c) => c.id === currentId);

  return (
    <div className="h-11 px-3 flex items-center gap-3 shrink-0 select-none">
      <ModelPill />
      <span
        data-tauri-drag-region
        className="text-sm text-text-muted/50 truncate flex-1 min-w-0 cursor-move"
      >
        {current?.title ?? 'New chat'}
      </span>
      <WinControls />
    </div>
  );
}
