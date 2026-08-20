import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Folder, Loader2 } from 'lucide-react';
import { useProjects, type Project } from '@/stores/projects';
import { useConversations } from '@/stores/conversations';
import { ProjectActions, ConversationActions } from '@/components/items/ItemActions';
import { NewProjectDialog } from '@/components/items/NewProjectDialog';
import { cn } from '@/lib/utils';

/**
 * Projects, and what is inside the one you open.
 *
 * Not a tree in the rail: opening a project fills the content area with its
 * chats, so the context you are in is the biggest thing on screen instead of a
 * disclosure triangle two levels deep in a column.
 */

export function ProjectsPage() {
  const navigate = useNavigate();
  const projects = useProjects((s) => s.list);
  const convs = useConversations((s) => s.list);
  const currentId = useConversations((s) => s.currentId);
  const streamingIds = useConversations((s) => s.streamingIds);
  const [open, setOpen] = useState<Project | null>(null);
  const [creating, setCreating] = useState(false);

  const inProject = open
    ? (convs ?? [])
      .filter((c) => open.conversation_ids.includes(c.id))
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    : [];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div data-tauri-drag-region className="h-10 shrink-0" />
      <div className="flex-1 overflow-y-auto scrollbar-hide">
        <div className="max-w-3xl mx-auto px-6 pb-10">
          {open ? (
            <>
              <button
                type="button"
                onClick={() => setOpen(null)}
                className="mb-4 text-sm text-text-muted hover:text-text-secondary cursor-pointer"
              >
                ← All projects
              </button>
              <h1 className="text-2xl font-semibold text-text-primary tracking-tight flex items-center gap-2">
                <Folder size={20} className="text-text-muted" aria-hidden />
                {open.name}
              </h1>
              <p className="mt-1 mb-6 text-sm text-text-muted">
                {inProject.length} {inProject.length === 1 ? 'chat' : 'chats'} in this project.
              </p>
              {inProject.length === 0 ? (
                <p className="text-sm text-text-muted">
                  Nothing in here yet. Move a chat into it from the chat's own menu.
                </p>
              ) : (
                <div className="space-y-1">
                  {inProject.map((c) => (
                    <div
                      key={c.id}
                      className={cn(
                        'group flex items-center gap-2 rounded-xl pr-2 transition-colors',
                        c.id === currentId ? 'bg-bg-active' : 'hover:bg-bg-hover',
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => { void useConversations.getState().open(c.id); navigate('/chat'); }}
                        className="flex-1 min-w-0 text-left px-4 py-3 cursor-pointer flex items-center gap-2"
                      >
                        {streamingIds[c.id] && (
                          <Loader2 size={12} className="shrink-0 animate-spin text-brand" aria-label="Generating" />
                        )}
                        <span className="text-sm text-text-primary truncate">{c.title}</span>
                      </button>
                      <ConversationActions conv={c} side="bottom" align="end" />
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="mb-6 flex items-baseline justify-between gap-4">
                <h1 className="text-2xl font-semibold text-text-primary tracking-tight">Projects</h1>
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="text-sm text-text-muted hover:text-text-secondary cursor-pointer"
                >
                  New project
                </button>
              </div>
              {projects.length === 0 ? (
                <p className="text-sm text-text-muted">
                  No projects yet. A project keeps related chats and files together — and
                  Feral is perfectly usable without ever making one.
                </p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {projects.map((p) => (
                    <div key={p.id} className="group flex items-center gap-1 rounded-xl border border-border-subtle bg-bg-surface/60 hover:bg-bg-hover transition-colors pr-2">
                      <button
                        type="button"
                        onClick={() => setOpen(p)}
                        className="flex-1 min-w-0 text-left px-4 py-4 cursor-pointer"
                      >
                        <span className="flex items-center gap-2 text-sm text-text-primary truncate">
                          <Folder size={14} className="shrink-0 text-text-muted" aria-hidden />
                          {p.name}
                        </span>
                        <span className="block mt-1 text-[11px] text-text-disabled">
                          {p.conversation_ids.length} {p.conversation_ids.length === 1 ? 'chat' : 'chats'}
                        </span>
                      </button>
                      <ProjectActions project={p} side="bottom" align="end" />
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <NewProjectDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
