import { Bot, Search, FileText, Code, Globe } from 'lucide-react';

export function WelcomeStep() {
  return (
    <div className="space-y-8 text-center">
      <div className="flex justify-center">
        <div className="w-14 h-14 rounded-2xl bg-brand/10 flex items-center justify-center">
          <Bot size={28} className="text-brand" />
        </div>
      </div>

      <div className="space-y-2">
        <h1 className="text-2xl font-bold text-text-primary tracking-tight">Meet Agents</h1>
        <p className="text-sm text-text-muted leading-relaxed">
          AI helpers you configure once and run anytime —<br />on your device, privately.
        </p>
      </div>

      <div className="space-y-3 text-left">
        {[
          { icon: Search,   text: 'Search the web and summarise findings' },
          { icon: FileText, text: 'Read and write files on your computer' },
          { icon: Code,     text: 'Write and run code snippets' },
          { icon: Globe,    text: 'Fetch and process data from web pages' },
        ].map(({ icon: Icon, text }) => (
          <div key={text} className="flex items-center gap-3 text-sm text-text-secondary">
            <Icon size={13} className="shrink-0 text-text-muted" />
            <span>{text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
