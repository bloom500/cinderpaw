import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { RefreshCw, CheckCircle, AlertCircle } from 'lucide-react';
import { useSettings } from '@/stores/settings';
import { useUI, type LangPref } from '@/stores/ui';
import { useUpdater } from '@/stores/updater';
import { useAppVersion } from '@/hooks/useAppVersion';
import { cn } from '@/lib/utils';

export function GeneralTab() {
  const settings    = useSettings((s) => s.settings);
  const update      = useSettings((s) => s.updateSettings);
  const save        = useSettings((s) => s.save);
  const saved       = useSettings((s) => s.saved);
  const language    = useUI((s) => s.language);
  const setLanguage = useUI((s) => s.setLanguage);

  const handleChangeFolder = async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected === 'string' && selected) {
      update({ models_dir: selected });
      await save();
    }
  };

  const handleOpenFolder = async () => {
    if (settings?.models_dir) {
      await shellOpen(settings.models_dir);
    }
  };

  const handleOpenLogs = async () => {
    if (!settings?.models_dir) return;
    // Go one level up from models_dir (e.g. ~/.feral/models → ~/.feral)
    const parent = settings.models_dir.replace(/[/\\][^/\\]+[/\\]?$/, '');
    await shellOpen(parent || settings.models_dir);
  };

  const updateStatus = useUpdater((s) => s.status);
  const updateError  = useUpdater((s) => s.error);
  const check        = useUpdater((s) => s.check);
  const appVersion   = useAppVersion();

  const rowCls = 'flex items-center justify-between gap-4';
  const btnCls = 'px-3 py-1.5 rounded-md border border-border-subtle text-sm text-text-secondary hover:bg-bg-hover transition-colors shrink-0';

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-text-primary">General</h2>

      {/* App version */}
      <div className={rowCls}>
        <div>
          <p className="text-sm font-medium text-text-primary">App version</p>
          <p className="text-xs text-text-muted mt-0.5">{appVersion ?? '…'}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {updateStatus === 'up-to-date' && (
            <span className="flex items-center gap-1 text-xs text-emerald-400">
              <CheckCircle size={12} /> Latest
            </span>
          )}
          {updateStatus === 'error' && (
            <span className="flex items-center gap-1 text-xs text-rose-400" title={updateError ?? ''}>
              <AlertCircle size={12} /> Error
            </span>
          )}
          <button
            type="button"
            onClick={() => void check()}
            disabled={updateStatus === 'checking' || updateStatus === 'downloading'}
            className={cn(btnCls, (updateStatus === 'checking' || updateStatus === 'downloading') && 'opacity-50 cursor-not-allowed')}
          >
            <span className="flex items-center gap-1.5">
              <RefreshCw size={13} className={cn(updateStatus === 'checking' && 'animate-spin')} />
              {updateStatus === 'downloading' ? 'Downloading…' : 'Check for updates'}
            </span>
          </button>
        </div>
      </div>

      {/* Language */}
      <div className={rowCls}>
        <div>
          <p className="text-sm font-medium text-text-primary">Language</p>
          <p className="text-xs text-text-muted mt-0.5">Interface language</p>
        </div>
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value as LangPref)}
          className="px-2 py-1.5 rounded-md border border-border-subtle bg-bg-surface text-sm text-text-primary"
        >
          <option value="en">English</option>
          <option value="ro">Română</option>
        </select>
      </div>

      {/* Data folder */}
      <div className={rowCls}>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-text-primary">Data folder</p>
          <p className="text-xs text-text-muted mt-0.5 truncate">
            {settings?.models_dir ?? '~/.feral/models'}
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button type="button" onClick={() => void handleChangeFolder()} className={btnCls}>
            Change
          </button>
          <button type="button" onClick={() => void handleOpenFolder()} className={btnCls}>
            Open
          </button>
        </div>
      </div>

      {/* App logs */}
      <div className={rowCls}>
        <div>
          <p className="text-sm font-medium text-text-primary">Application logs</p>
          <p className="text-xs text-text-muted mt-0.5">Detailed runtime logs for troubleshooting</p>
        </div>
        <button type="button" onClick={() => void handleOpenLogs()} className={btnCls}>
          Open logs
        </button>
      </div>

      {saved && <span className="text-sm text-text-muted">✓ Saved</span>}
    </div>
  );
}
