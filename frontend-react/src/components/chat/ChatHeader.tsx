import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useConversations } from '@/stores/conversations';
import { useProjects } from '@/stores/projects';
import { ConversationActions, RenameDialog } from '@/components/items/ItemActions';

export function ChatHeader() {
  const currentId = useConversations((s) => s.currentId);
  const list      = useConversations((s) => s.list);
  const current   = list?.find((c) => c.id === currentId);
  const project   = useProjects((s) =>
    current ? s.list.find((p) => p.conversation_ids.includes(current.id)) : undefined);
  const [renaming, setRenaming] = useState(false);

  if (!current) {
    // No title and no menu on Home: there is no conversation to name yet, and
    // "New chat" in the corner would label a thing that does not exist. The
    // strip stays, because a frameless window still has to be draggable.
    return <div data-tauri-drag-region className="h-12 shrink-0 select-none" />;
  }

  return (
    // The model pill used to sit here, in the corner, as the first thing on
    // the screen. It is in the composer now, where the choice is relevant.
    // The voice call stays in the composer too: its whole state lives there.
    <div
      data-tauri-drag-region
      className="h-15 pl-7 pr-5 flex items-center gap-2 shrink-0 select-none border-b border-border-subtle"
    >
      <span data-tauri-drag-region className="text-base font-semibold text-text-primary truncate min-w-0">
        {current.title}
      </span>
      <button
        type="button"
        aria-label="Rename chat"
        onClick={() => setRenaming(true)}
        className="p-1 rounded-md text-text-muted hover:text-text-secondary hover:bg-text-primary/5 shrink-0"
      >
        <ChevronDown size={16} />
      </button>
      {project && (
        <span data-tauri-drag-region className="text-2xs text-text-disabled truncate min-w-0">
          in {project.name}
        </span>
      )}
      <div data-tauri-drag-region className="flex-1 self-stretch" />
      <ConversationActions
        conv={current}
        side="bottom"
        align="end"
        className="opacity-100 h-8 w-8 p-0 flex items-center justify-center rounded-full border border-border-default"
      />
      {/* Keyed by chat: the header outlives a switch, and the dialog keeps the
          name it was first given. */}
      <RenameDialog
        key={current.id}
        open={renaming}
        onOpenChange={setRenaming}
        title="Rename chat"
        label="Chat name"
        initial={current.title}
        onSave={(title) => useConversations.getState().rename(current.id, title)}
      />
    </div>
  );
}
