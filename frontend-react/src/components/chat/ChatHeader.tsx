import { useState } from 'react';
import { ChevronDown, PanelRight } from 'lucide-react';
import { useConversations } from '@/stores/conversations';
import { useProjects } from '@/stores/projects';
import { useArtifacts } from '@/stores/artifacts';
import { useBrowser } from '@/stores/browser';
import { useUI } from '@/stores/ui';
import { useContextVisible } from '@/components/artifacts/ContextColumn';
import { ConversationActions, RenameDialog } from '@/components/items/ItemActions';

export function ChatHeader() {
  const currentId = useConversations((s) => s.currentId);
  const list      = useConversations((s) => s.list);
  const current   = list?.find((c) => c.id === currentId);
  const project   = useProjects((s) =>
    current ? s.list.find((p) => p.conversation_ids.includes(current.id)) : undefined);
  const [renaming, setRenaming] = useState(false);
  const contextOpen = useContextVisible();
  // The Context cards are their own column (29 Oct), not an Artifacts tab.
  const toggleContext = () => {
    if (contextOpen) { useUI.getState().setContextOpen(false); return; }
    useBrowser.getState().setPanel(false);
    useArtifacts.setState({ panelOpen: false });
    useUI.getState().setContextOpen(true);
  };

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
    // pr clears the window chrome: WinControls are fixed top-right at z-200,
    // three 40px buttons = 120px, and these header buttons sat right under
    // them — visible but dead (4 Oct 2026). 16px of air past the chrome.
    <div
      data-tauri-drag-region
      className="h-15 pl-7 pr-[136px] flex items-center gap-2 shrink-0 select-none border-b border-border-subtle"
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
      <button
        type="button"
        aria-label="Chat context"
        aria-pressed={contextOpen}
        title="Context"
        onClick={toggleContext}
        className="h-8 w-8 flex items-center justify-center rounded-full border border-border-default text-text-muted hover:text-text-primary hover:bg-text-primary/5 shrink-0"
      >
        <PanelRight size={16} />
      </button>
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
