import { RefreshCw, CheckCircle, AlertCircle } from 'lucide-react';
import { useUpdater } from '@/stores/updater';
import { useAppVersion } from '@/hooks/useAppVersion';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function AboutTab() {
  const version  = useAppVersion();
  const status   = useUpdater((s) => s.status);
  const progress = useUpdater((s) => s.progress);
  const error    = useUpdater((s) => s.error);
  const check    = useUpdater((s) => s.check);

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-text-primary">About</h2>

      <div className="space-y-1">
        <p className="text-sm font-semibold text-text-primary">Cinderpaw {version ?? '…'}</p>
        <p className="text-xs text-text-muted">Local-first AI desktop, built with Tauri + React</p>
        {/* Licence split (see root LICENSE): the agent runtime is Apache-2.0;
            the desktop app, TUI and adaptive core are BSL 1.1, converting to
            Apache 2.0 four years after each release. A licence line is
            something people act on, so it states the real terms. */}
        <p className="text-xs text-text-muted">
          Built by <span className="font-medium text-text-secondary">Bloom Media</span> · Runtime Apache-2.0 · App BSL 1.1
        </p>
        <p className="text-xs text-text-muted">
          Runtime: use, modify and redistribute freely, including hosted. App and
          adaptive core: source-available — no resale as a hosted service. Each
          release turns Apache 2.0 four years after it ships.
        </p>
      </div>

      {/* Update section — the install flow itself is handled by the global UpdateToast */}
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          onClick={() => void check()}
          disabled={status === 'checking' || status === 'downloading'}
          className="gap-2"
        >
          <RefreshCw size={14} className={cn(status === 'checking' && 'animate-spin')} />
          {status === 'downloading' ? `Downloading… ${progress}%` : 'Check for updates'}
        </Button>

        {status === 'up-to-date' && (
          <span className="flex items-center gap-1.5 text-xs font-medium rounded-full px-2.5 py-1 bg-success text-white shadow-sm">
            <CheckCircle size={13} /> You're on the latest version
          </span>
        )}
        {status === 'error' && (
          <span className="flex items-center gap-1 text-xs text-error">
            <AlertCircle size={13} /> {error}
          </span>
        )}
      </div>

      <div className="space-y-2">
        <a
          href="https://github.com/bloom500/cinderpaw"
          target="_blank"
          rel="noreferrer"
          className="block text-sm text-info hover:underline"
        >
          View on GitHub →
        </a>
        <a
          href="https://github.com/bloom500/cinderpaw/issues"
          target="_blank"
          rel="noreferrer"
          className="block text-sm text-info hover:underline"
        >
          Report an issue →
        </a>
      </div>
    </div>
  );
}
