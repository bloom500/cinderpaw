import { useSettings } from '@/stores/settings';

export function AboutTab() {
  const version = useSettings((s) => s.settings?.version ?? 'v0.1.0');

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-text-primary">About</h2>

      <div className="space-y-1">
        <p className="text-sm font-semibold text-text-primary">Feral {version}</p>
        <p className="text-xs text-text-muted">Local-first AI desktop, built with Tauri + React</p>
        <p className="text-xs text-text-muted">
          Built by <span className="font-medium text-text-secondary">Bloom Lab</span> · License: MIT + Apache 2.0
        </p>
      </div>

      <div className="space-y-2">
        <a
          href="https://github.com/bloommediacorporation-lab/feral"
          target="_blank"
          rel="noreferrer"
          className="block text-sm text-blue-400 hover:underline"
        >
          View on GitHub →
        </a>
        <a
          href="https://github.com/bloommediacorporation-lab/feral/issues"
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
