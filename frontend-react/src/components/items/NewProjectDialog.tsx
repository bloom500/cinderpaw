import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useProjects } from '@/stores/projects';

/**
 * Creating a project, lifted out of the sidebar because the sidebar is being
 * deleted and two callers now need it: the rail (until S4) and the top nav's
 * "+ New". Lifted rather than copied — a second copy would drift, and the one
 * thing this dialog must never do is create a project under a name the user
 * did not type.
 */
export function NewProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState('');

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    await useProjects.getState().create(trimmed);
    setName('');
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setName('');
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="sm:max-w-sm"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement | null)?.querySelector<HTMLInputElement>('input')?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>New Project</DialogTitle>
        </DialogHeader>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
          placeholder="Project name"
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
            onClick={() => void create()}
            disabled={!name.trim()}
            className="px-3 py-1.5 text-sm rounded bg-brand text-on-brand disabled:opacity-40"
          >
            Create
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
