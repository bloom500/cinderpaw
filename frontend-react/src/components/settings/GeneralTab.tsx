import { useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { RefreshCw, CheckCircle, AlertCircle, Sparkles } from 'lucide-react';
import { useSettings } from '@/stores/settings';
import { useUI, type LangPref, type WhisperModel } from '@/stores/ui';
import { useUpdater } from '@/stores/updater';
import { useAppVersion } from '@/hooks/useAppVersion';
import { useOnboarding } from '@/stores/onboarding';
import { cn } from '@/lib/utils';

export function GeneralTab() {
  const settings    = useSettings((s) => s.settings);
  const update      = useSettings((s) => s.updateSettings);
  const save        = useSettings((s) => s.save);
  const saved       = useSettings((s) => s.saved);
  const language    = useUI((s) => s.language);
  const setLanguage = useUI((s) => s.setLanguage);
  const whisperModel    = useUI((s) => s.whisperModel);
  const setWhisperModel = useUI((s) => s.setWhisperModel);
  const reopenOnboarding = useOnboarding((s) => s.reopen);

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

  const [autoUpdateCheck, setAutoUpdateCheck] = useState(
    localStorage.getItem('cinderpaw.autoUpdateCheck') !== 'off',
  );
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

      {/* Automatic update check (privacy: the check contacts GitHub Releases) */}
      <div className={rowCls}>
        <div>
          <p className="text-sm font-medium text-text-primary">Check for updates at startup</p>
          <p className="text-xs text-text-muted mt-0.5">
            Compares your version against GitHub Releases once per launch. Only the version request
            is sent, no usage data. Turn off for a fully offline app.
          </p>
        </div>
        <input
          type="checkbox"
          checked={autoUpdateCheck}
          onChange={(e) => {
            setAutoUpdateCheck(e.target.checked);
            localStorage.setItem('cinderpaw.autoUpdateCheck', e.target.checked ? 'on' : 'off');
          }}
          className="h-4 w-4 accent-orange-500 shrink-0"
        />
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

      {/* Voice transcription model */}
      <div className={rowCls}>
        <div>
          <p className="text-sm font-medium text-text-primary">Voice transcription</p>
          <p className="text-xs text-text-muted mt-0.5">
            On-device speech-to-text model for voice messages
          </p>
        </div>
        <select
          value={whisperModel}
          onChange={(e) => setWhisperModel(e.target.value as WhisperModel)}
          className="px-2 py-1.5 rounded-md border border-border-subtle bg-bg-surface text-sm text-text-primary"
        >
          <option value="small">Small (~466 MB, better accuracy)</option>
          <option value="base">Base (~142 MB, lighter)</option>
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

      {/* Re-run onboarding — useful for renaming yourself or the agent,
          or for seeing a fresh welcome after major UI changes. The wizard
          re-opens immediately (no confirm) — the user is in Settings and
          knows what they're doing. */}
      <div className={rowCls}>
        <div>
          <p className="text-sm font-medium text-text-primary">Welcome tour</p>
          <p className="text-xs text-text-muted mt-0.5">
            Re-run the first-time setup. Useful for renaming yourself or the agent.
          </p>
        </div>
        <button
          type="button"
          onClick={reopenOnboarding}
          className={btnCls}
        >
          <Sparkles size={12} className="inline -mt-0.5 mr-1" /> Re-run welcome
        </button>
      </div>

      {saved && <span className="text-sm text-text-muted">✓ Saved</span>}
    </div>
  );
}
