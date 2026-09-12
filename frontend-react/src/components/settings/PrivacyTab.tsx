export function PrivacyTab() {
  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-text-primary">Privacy</h2>

      <div className="flex gap-4 p-4 rounded-lg border border-border-subtle bg-bg-surface">
        <span className="text-2xl shrink-0">⚿</span>
        <div>
          <p className="text-sm font-medium text-text-primary">Local storage, with network access for online features</p>
          <p className="text-xs text-text-muted mt-1">
            Local models run on your hardware. Cloud models, web tools, connectors, and configured
            background tasks can send data to external services.
          </p>
        </div>
      </div>

      <div>
        <p className="text-sm font-medium text-text-primary">Data collection</p>
        <p className="text-xs text-text-muted mt-0.5">No automatic analytics or crash-report uploads. Online features still transmit the data they need.</p>
      </div>

      <ul className="space-y-1.5 text-sm text-text-secondary">
        {[
          'Conversation history is stored locally; cloud requests include conversation context',
          'Downloaded models are stored on disk; cloud models run at their providers',
          'Update checks and missing model or toolchain downloads can use the network at startup',
          'Configured background tasks, verification, and fallbacks can also contact cloud providers',
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
