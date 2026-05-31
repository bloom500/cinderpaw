import { useConversations } from '@/stores/conversations';
import { ModelPill } from './ModelPill';

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
    </div>
  );
}
