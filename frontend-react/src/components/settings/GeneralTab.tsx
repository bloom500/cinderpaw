import { useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { useSettings } from '@/stores/settings';

export function GeneralTab() {
  const settings = useSettings((s) => s.settings);
  const update   = useSettings((s) => s.updateSettings);
  const save     = useSettings((s) => s.save);
  const saved    = useSettings((s) => s.saved);
  const [language, setLanguage] = useState('en');

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

  const rowCls = 'flex items-center justify-between gap-4';
  const btnCls = 'px-3 py-1.5 rounded-md border border-border-subtle text-sm text-text-secondary hover:bg-bg-hover transition-colors shrink-0';

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-text-primary">General</h2>

      {/* App version */}
      <div className={rowCls}>
        <div>
          <p className="text-sm font-medium text-text-primary">App version</p>
          <p className="text-xs text-text-muted mt-0.5">{settings?.version ?? 'v0.1.0'}</p>
        </div>
        <button type="button" disabled className={`${btnCls} opacity-50 cursor-not-allowed`}>
          Check for updates
        </button>
      </div>

      {/* Language */}
      <div className={rowCls}>
        <div>
          <p className="text-sm font-medium text-text-primary">Language</p>
          <p className="text-xs text-text-muted mt-0.5">Interface language</p>
        </div>
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
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
