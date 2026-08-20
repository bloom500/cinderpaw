export function PrivacyTab() {
  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-text-primary">Privacy</h2>

      <div className="flex gap-4 p-4 rounded-lg border border-border-subtle bg-bg-surface">
        <span className="text-2xl shrink-0">⚿</span>
        <div>
          <p className="text-sm font-medium text-text-primary">Your data never leaves this machine</p>
          <p className="text-xs text-text-muted mt-1">
            Feral runs entirely on your hardware. No telemetry, no analytics, no cloud sync, by design.
          </p>
        </div>
      </div>

      <div>
        <p className="text-sm font-medium text-text-primary">Data collection</p>
        <p className="text-xs text-text-muted mt-0.5">Disabled. Feral never collects or transmits your data</p>
      </div>

      <ul className="space-y-1.5 text-sm text-text-secondary">
        {[
          'All conversations stored locally only',
          'Models stored locally only',
          'No background network requests',
          'Cloud providers (BYOK) only contacted when you explicitly send a message',
        ].map((item) => (
          <li key={item} className="flex items-start gap-2">
            <span className="text-text-muted mt-0.5">·</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
