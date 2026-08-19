import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FolderOpen, Info, X } from 'lucide-react';
import { useResumeTask, formatRelative } from '@/components/shell/WelcomeBack';
import { RecentWork, useRecentWork } from '@/components/shell/RecentWork';
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
        recommend a cloud model:{' '}
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

interface NewChatEmptyStateProps {
  isEmpty: boolean;
  onSuggestion: (text: string) => void;
}

export function NewChatEmptyState({ isEmpty, onSuggestion }: NewChatEmptyStateProps) {
  const isAgentMode = useUI((s) => s.inputMode) === 'agent';
  const t = useT();
  const resume = useResumeTask();
  const [suggestions] = useState(() => getRandomSuggestions(3));
  const [greetingIndex, setGreetingIndex] = useState(0);
  const [greetingVisible, setGreetingVisible] = useState(true);
  // Extra room above the composer only when the cards are actually there; a
  // fresh install keeps the greeting exactly where it has always been.
  const hasRecent = useRecentWork() !== null;

  useEffect(() => {
    // Memory Resume takes the hero slot — no greeting rotation.
    if (!isEmpty || resume) return;
    const id = setInterval(() => {
      setGreetingVisible(false);
      setTimeout(() => {
        setGreetingIndex((i) => (i + 1) % GREETING_KEYS.length);
        setGreetingVisible(true);
      }, 350);
    }, 4000);
    return () => clearInterval(id);
  }, [isEmpty, resume]);

  return (
    <div
      className={cn(
        'absolute inset-0 pointer-events-none transition-opacity duration-200',
        isEmpty ? 'opacity-100' : 'opacity-0',
      )}
    >
      {/* Greeting + pills as one column, pushed above the centered input */}
      <div className={cn(
        'absolute inset-0 flex flex-col items-center justify-center',
        hasRecent ? 'pb-[26rem]' : 'pb-72',
      )}>
        {resume ? (
          <>
            <h1 className="text-2xl font-semibold text-text-primary select-none">
              {t('empty.welcomeBack')} <span className="text-brand">{resume.title}</span>
            </h1>
            <span className="mt-1.5 flex items-center gap-1 text-xs text-text-muted select-none">
              {resume.workspaceName && (
                <>
                  <FolderOpen size={11} aria-hidden />
                  <span>in {resume.workspaceName}</span>
                  <span aria-hidden>·</span>
                </>
              )}
              <span>{formatRelative(resume.ts)}</span>
            </span>
          </>
        ) : (
          <h1
            className="text-2xl font-semibold text-text-primary select-none transition-opacity duration-300"
            style={{ opacity: greetingVisible ? 1 : 0 }}
          >
            {t(GREETING_KEYS[greetingIndex])}
          </h1>
        )}

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

        {/* Where you left off, for the launch where the question is "what was
            I doing" rather than "find me that thing". Renders nothing on a
            fresh install. */}
        <RecentWork />

        {isAgentMode && <AgentByokNote />}
      </div>
    </div>
  );
}
