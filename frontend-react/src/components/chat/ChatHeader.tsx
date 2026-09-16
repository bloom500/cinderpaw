import { FileBox } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useArtifacts } from '@/stores/artifacts';
import { useConversations } from '@/stores/conversations';

export function ChatHeader() {
  const panelOpen   = useArtifacts((s) => s.panelOpen);
  const togglePanel = useArtifacts((s) => s.togglePanel);
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
      {/* The workspace's only entrance. Without it the store is a capability
          the agent has and the person does not: artifacts would exist, be
          listed by tools, and have nowhere on screen to be opened from. */}
      <button
        type="button"
        onClick={togglePanel}
        aria-label="Workspace"
        aria-pressed={panelOpen}
        title="Workspace"
        className={cn(
          'shrink-0 rounded p-1.5 hover:bg-bg-hover',
          panelOpen ? 'text-text-primary' : 'text-text-muted hover:text-text-primary',
        )}
      >
        <FileBox size={16} />
      </button>
    </div>
  );
}
