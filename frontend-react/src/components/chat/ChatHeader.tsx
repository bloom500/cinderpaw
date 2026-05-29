import { useModel } from '@/stores/model';
import { useConversations } from '@/stores/conversations';

export function ChatHeader() {
  const loaded = useModel((s) => s.loaded);
  const currentId = useConversations((s) => s.currentId);
  const list = useConversations((s) => s.list);
  const current = list.find((c) => c.id === currentId);

  return (
    <div className="h-12 px-4 flex items-center justify-between shrink-0 border-b border-border-subtle">
      <span className="text-sm text-text-secondary truncate">
        {current?.title ?? 'New chat'}
      </span>
      <span className="text-xs text-text-muted">{loaded?.name ?? 'No model'}</span>
    </div>
  );
}
