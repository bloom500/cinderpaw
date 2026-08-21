/**
 * Phase 4 S2 — item-level actions for a conversation or a project.
 *
 * These lived inside `Sidebar.tsx`, with the menu in the row and the rename /
 * delete dialogs lifted to the sidebar root. That shape only works for one
 * host: any other place that lists a chat — Search, Home, a project page —
 * would have to rebuild both dialogs to offer the same actions, and a chat you
 * can find but cannot delete is a rail you have not actually replaced.
 *
 * So each component owns its whole interaction: trigger, menu, and the dialogs
 * the menu opens. A host renders one element and gets the behaviour. The
 * dialogs are per-row state, which is cheap — Radix only mounts the content
 * while it is open — and it is what makes the actions portable.
 */

import { useState, type ReactNode } from 'react';
import {
  MoreHorizontal, Trash2, FolderInput, FolderMinus, Folder, AlertCircle, Pencil,
} from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub,
  DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useConversations, type ConversationSummary } from '@/stores/conversations';
import { useProjects, type Project } from '@/stores/projects';

/** Hover-reveal in a list; stays visible once focused, so the keyboard reaches it. */
const TRIGGER_CLASS =
  'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 ' +
  'p-1 rounded hover:bg-bg-hover text-text-muted hover:text-text-secondary shrink-0';

function ActionsTrigger({ label, className }: { label: string; className?: string }) {
  return (
    <DropdownMenuTrigger asChild>
      <button type="button" aria-label={label} className={cn(TRIGGER_CLASS, className)}>
        <MoreHorizontal size={13} />
      </button>
    </DropdownMenuTrigger>
  );
}

/**
 * Confirm-and-run for a destructive action. It keeps the failure on screen
 * instead of closing: a delete that silently did nothing is worse than one
 * that says why it could not.
 */
function ConfirmDeleteDialog({
  open, onOpenChange, title, body, onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body: ReactNode;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => { setError(null); onOpenChange(false); };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) close(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-text-secondary">{body}</p>
        {error && (
          <div className="flex items-start gap-2 rounded-md border border-error/30 bg-error/5 p-3">
            <AlertCircle size={13} className="text-error shrink-0 mt-0.5" />
            <p className="text-sm text-error">{error}</p>
          </div>
        )}
        <DialogFooter>
          <button
            type="button"
            onClick={close}
            disabled={busy}
            className="px-3 py-1.5 text-sm rounded text-text-muted hover:bg-bg-hover disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void run()}
            disabled={busy}
            className="px-3 py-1.5 text-sm rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
          >
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Single-field rename. Enter saves, so the mouse is optional. */
function RenameDialog({
  open, onOpenChange, title, label, initial, onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Names the field, distinctly from the dialog heading. */
  label: string;
  initial: string;
  onSave: (name: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(initial);

  const save = async () => {
    const name = draft.trim();
    if (!name) return;
    await onSave(name);
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) setDraft(initial); onOpenChange(next); }}
    >
      <DialogContent
        className="sm:max-w-sm"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement | null)?.querySelector<HTMLInputElement>('input')?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void save(); }}
          placeholder={label}
          aria-label={label}
          className="w-full rounded-md border border-bg-hover bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:ring-1 focus:ring-brand placeholder:text-text-muted"
        />
        <DialogFooter>
          <button
            onClick={() => onOpenChange(false)}
            className="px-3 py-1.5 text-sm rounded text-text-muted hover:bg-bg-hover"
          >
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={!draft.trim()}
            className="px-3 py-1.5 text-sm rounded bg-brand text-on-brand disabled:opacity-40"
          >
            Save
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Actions for one conversation: move it into a project, take it out, delete it.
 *
 * Which project the chat sits in is looked up, not passed in. A host that
 * lists chats without a project tree — Search, Home — has no way to know, and
 * "Remove from project" has to work there too, or a chat can get stuck inside
 * a container only the sidebar could open.
 */
export function ConversationActions({
  conv, side = 'right', align = 'start', className,
}: {
  conv: Pick<ConversationSummary, 'id' | 'title'>;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  className?: string;
}) {
  const projects = useProjects((s) => s.list);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState(false);

  const parent = projects.find((p) => p.conversation_ids.includes(conv.id)) ?? null;

  return (
    <>
      <DropdownMenu>
        <ActionsTrigger label="Chat options" className={className} />
        <DropdownMenuContent side={side} align={align}>
          <DropdownMenuItem onClick={() => setRenaming(true)}>
            <Pencil size={13} />
            Rename
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {parent ? (
            <DropdownMenuItem
              onClick={() => void useProjects.getState().removeChat(parent.id, conv.id).catch(console.error)}
            >
              <FolderMinus size={13} />
              Remove from project
            </DropdownMenuItem>
          ) : (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={projects.length === 0}>
                <FolderInput size={13} />
                {projects.length === 0 ? 'No projects yet' : 'Add to project'}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {projects.map((p) => (
                  <DropdownMenuItem
                    key={p.id}
                    onClick={() => void useProjects.getState().addChat(p.id, conv.id).catch(console.error)}
                  >
                    <Folder size={13} />
                    {p.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => setConfirmDelete(true)}
            className="text-error focus:text-error"
          >
            <Trash2 size={13} />
            Delete chat
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <RenameDialog
        open={renaming}
        onOpenChange={setRenaming}
        title="Rename chat"
        label="Chat name"
        initial={conv.title}
        onSave={(title) => useConversations.getState().rename(conv.id, title)}
      />

      <ConfirmDeleteDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this chat?"
        body={<>This permanently deletes <span className="text-text-primary">{conv.title || 'this chat'}</span>. This can&apos;t be undone.</>}
        onConfirm={() => useConversations.getState().delete(conv.id)}
      />
    </>
  );
}

/** Actions for one project: rename it, or delete it with everything inside. */
export function ProjectActions({
  project, side = 'right', align = 'start', className,
}: {
  project: Pick<Project, 'id' | 'name'>;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  className?: string;
}) {
  const [renaming, setRenaming]           = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <>
      <DropdownMenu>
        <ActionsTrigger label="Project options" className={className} />
        <DropdownMenuContent side={side} align={align}>
          <DropdownMenuItem onClick={() => setRenaming(true)}>Rename</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => setConfirmDelete(true)}
            className="text-error focus:text-error"
          >
            <Trash2 size={13} />
            Delete project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <RenameDialog
        open={renaming}
        onOpenChange={setRenaming}
        title="Rename Project"
        label="Project name"
        initial={project.name}
        onSave={(name) => useProjects.getState().rename(project.id, name)}
      />

      <ConfirmDeleteDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this project?"
        body={<>This permanently deletes <span className="text-text-primary">{project.name || 'the project'}</span> and every conversation inside it. This can&apos;t be undone.</>}
        onConfirm={() => useProjects.getState().delete(project.id)}
      />
    </>
  );
}
