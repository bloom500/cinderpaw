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
        <p className="text-sm font-semibold text-text-primary">Feral {version ?? '…'}</p>
        <p className="text-xs text-text-muted">Local-first AI desktop, built with Tauri + React</p>
        <p className="text-xs text-text-muted">
          Built by <span className="font-medium text-text-secondary">Bloom Lab</span> · License: MIT + Apache 2.0
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
          <span className="flex items-center gap-1 text-xs text-emerald-400">
            <CheckCircle size={13} /> You're on the latest version
          </span>
        )}
        {status === 'error' && (
          <span className="flex items-center gap-1 text-xs text-rose-400">
            <AlertCircle size={13} /> {error}
          </span>
        )}
      </div>

      <div className="space-y-2">
        <a
          href="https://github.com/bloom500/feral"
          target="_blank"
          rel="noreferrer"
          className="block text-sm text-blue-400 hover:underline"
        >
          View on GitHub →
        </a>
        <a
          href="https://github.com/bloom500/feral/issues"
          target="_blank"
          rel="noreferrer"
          className="block text-sm text-blue-400 hover:underline"
        >
          Report an issue →
        </a>
      </div>
    </div>
  );
}
