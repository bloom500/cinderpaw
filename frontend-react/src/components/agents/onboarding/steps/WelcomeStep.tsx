import { Bot, Search, FileText, Code, Globe } from 'lucide-react';

export function WelcomeStep() {
  return (
    <div className="max-w-md mx-auto space-y-6 pt-4">
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-brand">
          <Bot size={28} />
        </div>
        <h1 className="text-2xl font-semibold text-text-primary">Meet Agents</h1>
        <p className="text-text-secondary text-sm leading-relaxed">
          Agents are AI helpers you configure once and use whenever you need them.
          They can search the web, read and write files, run code, and more —
          working step-by-step until the task is done.
        </p>
      </div>

      <div className="space-y-2.5">
        {[
          { icon: Search,   text: 'Search the web and summarise findings' },
          { icon: FileText, text: 'Read and write files on your computer' },
          { icon: Code,     text: 'Write and run code snippets to verify output' },
          { icon: Globe,    text: 'Fetch and process data from web pages' },
        ].map(({ icon: Icon, text }) => (
          <div key={text} className="flex items-center gap-3 text-sm text-text-secondary">
            <Icon size={14} className="shrink-0 text-text-muted" />
            <span>{text}</span>
          </div>
        ))}
      </div>

      <p className="text-xs text-text-muted">
        Let's set up your first agent — it takes about a minute.
      </p>
    </div>
  );
}
