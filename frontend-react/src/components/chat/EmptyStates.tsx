import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Info, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getRandomSuggestions } from '@/lib/suggestions';
import { useT } from '@/lib/i18n';
import { useUI } from '@/stores/ui';
import { cn } from '@/lib/utils';

const BYOK_DISCLAIMER_KEY = 'feral.agentByokDismissed';

/** One-time note recommending BYOK for agent mode on low-compute machines. */
function AgentByokNote() {
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(BYOK_DISCLAIMER_KEY) === 'true',
  );
  if (dismissed) return null;

  const dismiss = () => {
    localStorage.setItem(BYOK_DISCLAIMER_KEY, 'true');
    setDismissed(true);
  };

  return (
    <div className="mt-4 flex items-start gap-2 max-w-md px-3 py-2 rounded-lg border border-border-subtle bg-bg-surface/60 text-text-muted pointer-events-auto">
      <Info size={14} className="shrink-0 mt-0.5 text-text-muted" />
      <p className="text-xs leading-relaxed">
        Local models need significant compute. For smoother performance we
        recommend a cloud model —{' '}
        <button
          type="button"
          onClick={() => navigate('/settings')}
          className="text-brand hover:underline"
        >
          add a key (BYOK)
        </button>
        .
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="shrink-0 -mr-1 -mt-0.5 p-1 rounded hover:bg-bg-hover text-text-muted hover:text-text-secondary"
      >
        <X size={12} />
      </button>
    </div>
  );
}

const GREETING_KEYS = [
  'empty.greeting.1',
  'empty.greeting.2',
  'empty.greeting.3',
  'empty.greeting.4',
  'empty.greeting.5',
] as const;

export function NoModelEmptyState() {
  const navigate = useNavigate();
  const t = useT();
  return (
    <div className="h-full flex flex-col items-center justify-center text-text-muted px-6">
      <h2 className="text-xl text-text-secondary mb-2">{t('empty.noModel.title')}</h2>
      <p className="mb-6 text-center">{t('empty.noModel.body')}</p>
      <div className="flex gap-3">
        <Button variant="outline" onClick={() => navigate('/models')}>
          {t('empty.noModel.openModels')}
        </Button>
        <Button variant="outline" onClick={() => navigate('/settings')}>
          {t('empty.noModel.cloudKeys')}
        </Button>
      </div>
    </div>
  );
}

interface NewChatEmptyStateProps {
  isEmpty: boolean;
  onSuggestion: (text: string) => void;
}

export function NewChatEmptyState({ isEmpty, onSuggestion }: NewChatEmptyStateProps) {
  const isAgentMode = useUI((s) => s.inputMode) === 'agent';
  const t = useT();
  const [suggestions] = useState(() => getRandomSuggestions(3));
  const [greetingIndex, setGreetingIndex] = useState(0);
  const [greetingVisible, setGreetingVisible] = useState(true);

  useEffect(() => {
    if (!isEmpty) return;
    const id = setInterval(() => {
      setGreetingVisible(false);
      setTimeout(() => {
        setGreetingIndex((i) => (i + 1) % GREETING_KEYS.length);
        setGreetingVisible(true);
      }, 350);
    }, 4000);
    return () => clearInterval(id);
  }, [isEmpty]);

  return (
    <div
      className={cn(
        'absolute inset-0 pointer-events-none transition-opacity duration-200',
        isEmpty ? 'opacity-100' : 'opacity-0',
      )}
    >
      {/* Greeting + pills as one column, pushed above the centered input */}
      <div className="absolute inset-0 flex flex-col items-center justify-center pb-72">
        <h1
          className="text-2xl font-semibold text-text-primary select-none transition-opacity duration-300"
          style={{ opacity: greetingVisible ? 1 : 0 }}
        >
          {t(GREETING_KEYS[greetingIndex])}
        </h1>

        <div className="mt-5 flex flex-wrap justify-center gap-2 px-6 pointer-events-auto">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onSuggestion(s)}
              className="px-4 py-1.5 rounded-full border border-border-default bg-bg-surface hover:bg-bg-hover text-sm text-text-secondary transition-colors cursor-pointer"
            >
              {s}
            </button>
          ))}
        </div>

        {isAgentMode && <AgentByokNote />}
      </div>
    </div>
  );
}
