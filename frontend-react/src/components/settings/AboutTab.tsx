import { RefreshCw, CheckCircle, AlertCircle } from 'lucide-react';
import { useUpdater } from '@/stores/updater';
import { useAppVersion } from '@/hooks/useAppVersion';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { BugReportForm } from './BugReportForm';

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
        {/* A licence line is something people act on: it decides whether they can
            use Cinderpaw at work, so it states the real terms rather than a
            friendly summary. Keep it in step with LICENSE and with `license` in
            Cargo.toml and package.json. */}
        <p className="text-xs text-text-muted">
          Built by <span className="font-medium text-text-secondary">Bloom Media</span> · Apache License 2.0
        </p>
        <p className="text-xs text-text-muted">
          Open source. Use, modify, redistribute and sell it, commercially or not, with
          no revenue threshold and no separate licence to buy. Keep the notice and the
          licence with any copy you pass on.
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
          <span className="flex items-center gap-1.5 text-xs font-medium rounded-full px-2.5 py-1 bg-success text-primary-foreground shadow-sm">
            <CheckCircle size={13} /> You're on the latest version
          </span>
        )}
        {status === 'error' && (
          <span className="flex items-center gap-1 text-xs text-error">
            <AlertCircle size={13} /> {error}
          </span>
        )}
      </div>

      <BugReportForm />

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
          Open an issue on GitHub →
        </a>
      </div>
    </div>
  );
}
