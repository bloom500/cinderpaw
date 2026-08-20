import { useConversations } from '@/stores/conversations';

export function ChatHeader() {
  const currentId = useConversations((s) => s.currentId);
  const list      = useConversations((s) => s.list);
  const current   = list?.find((c) => c.id === currentId);

  return (
    // The model pill used to sit here, in the corner, as the first thing on
    // the screen. It is in the composer now, where the choice is relevant.
    <div className="h-12 px-3 flex items-center gap-3 shrink-0 select-none">
      <span
        data-tauri-drag-region
        className="text-sm text-text-muted truncate flex-1 min-w-0 cursor-move"
      >
        {/* No fallback title. On Home there is no conversation to name, and
            "New chat" in the corner labels a thing that does not exist yet —
            noise above a screen whose whole job is one question. The strip
            stays: a frameless window still has to be draggable. */}
        {current?.title ?? ''}
      </span>
    </div>
  );
}
