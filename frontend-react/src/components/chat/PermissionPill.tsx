import { useEffect } from 'react';
import { Eye, PencilLine, ShieldAlert } from 'lucide-react';
import { tauri, type PermissionMode } from '@/lib/tauri';
import { useSettings } from '@/stores/settings';
import { useNotifications } from '@/stores/notifications';
import { cn } from '@/lib/utils';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/** Each mode says what happens, in the words a person would use (Claude's composer, 20 Oct). */
export const MODES: Record<PermissionMode, { label: string; does: string; icon: typeof Eye }> = {
  read_only: { label: 'Look only', does: 'Reads files and the web. Changes nothing on this computer.', icon: Eye },
  workspace_write: {
    label: 'Can edit files',
    does: 'Changes files in its workspace, where you can undo. Asks before anything outside it.',
    icon: PencilLine,
  },
  full_access: {
    label: 'Full access',
    does: 'Works in any folder and runs any command. Asks before deleting what it cannot undo. Refuses commands that wipe a disk.',
    icon: ShieldAlert,
  },
};

/**
 * What Cinderpaw may do without asking, at the place you type. The mode lived
 * only in settings.json, so nobody knew it existed (audit, 20 Oct). The
 * sidecar re-reads it every 2 s: a change applies to the next step, no restart.
 */
export function PermissionPill() {
  const loaded = useSettings((s) => !!s.settings);
  // Read once, so a mode set from the CLI shows here, not the default.
  useEffect(() => { if (!loaded) void useSettings.getState().fetchSettings(); }, [loaded]);
  const mode = useSettings((s) => s.settings?.permission_mode) ?? 'workspace_write';
  const current = MODES[mode];
  const choose = (next: string) => {
    const m = next as PermissionMode;
    if (m === mode) return;
    tauri.settings.setPermissionMode(m).then(
      () => useSettings.getState().updateSettings({ permission_mode: m }),
      (err) => useNotifications.getState().push('error', 'Could not change what Cinderpaw may do', String(err)),
    );
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`What Cinderpaw may do: ${current.label}`}
        className={cn(
          'flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-2xs hover:bg-bg-hover transition-colors',
          mode === 'full_access' ? 'text-warning' : 'text-text-muted',
        )}
      >
        <current.icon size={12} aria-hidden />
        <span className="hidden sm:inline">{current.label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuRadioGroup value={mode} onValueChange={choose}>
          {(Object.keys(MODES) as PermissionMode[]).map((m) => (
            <DropdownMenuRadioItem key={m} value={m} className="flex-col items-start gap-0.5 py-2">
              <span className={cn('text-sm', m === 'full_access' && 'text-warning')}>{MODES[m].label}</span>
              <span className="text-xs text-text-muted">{MODES[m].does}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
