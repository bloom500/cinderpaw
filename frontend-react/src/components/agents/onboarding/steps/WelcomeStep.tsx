const FEATURES = [
  { emoji: '🔎', title: 'Research', text: 'Search the web and summarise what it finds' },
  { emoji: '📂', title: 'Files', text: 'Read, write and organize files on your computer' },
  { emoji: '💻', title: 'Code', text: 'Write and run code snippets for you' },
  { emoji: '🌐', title: 'Web data', text: 'Fetch and process data from web pages' },
];

export function WelcomeStep() {
  return (
    <div className="space-y-8 text-center">
      <div className="space-y-3">
        <div className="text-5xl leading-none" aria-hidden="true">👋</div>
        <h1 className="text-2xl font-bold text-text-primary tracking-tight">Meet Agents</h1>
        <p className="text-sm text-text-muted leading-relaxed">
          Little AI helpers you set up once and run anytime,<br />
          on your device, <span className="text-text-secondary">privately</span>. 🔒
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 text-left">
        {FEATURES.map(({ emoji, title, text }) => (
          <div
            key={title}
            className="rounded-xl border border-border-subtle bg-bg-surface p-4 space-y-1.5
                       hover:border-brand/40 hover:bg-bg-hover transition-colors"
          >
            <div className="text-2xl leading-none" aria-hidden="true">{emoji}</div>
            <p className="text-sm font-semibold text-text-primary">{title}</p>
            <p className="text-xs text-text-muted leading-relaxed">{text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
