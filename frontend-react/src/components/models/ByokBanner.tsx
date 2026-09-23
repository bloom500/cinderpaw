import { useNavigate } from 'react-router-dom';
import { Cloud, ChevronRight } from 'lucide-react';

export function ByokBanner() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate('/settings?cat=byok')}
      className="w-full flex items-center gap-2 px-4 py-2 bg-bg-surface border-b border-border-subtle text-text-muted text-sm hover:bg-bg-hover transition-colors shrink-0"
    >
      <Cloud size={14} className="shrink-0" />
      <span>Cloud models work on any computer. Add OpenAI, Anthropic, OpenRouter and others in</span>
      {/* The tab is called Cloud Keys; "BYOK" was a name only the code used. */}
      <span className="text-brand font-medium">Settings → Cloud Keys</span>
      <ChevronRight size={12} className="ml-auto shrink-0" />
    </button>
  );
}
