import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FolderOpen, Info, X } from 'lucide-react';
import { useResumeTask, formatRelative } from '@/components/shell/WelcomeBack';
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

/** Local wall-clock hour, so the greeting matches the room the user is in. */
function greetingKey(hour = new Date().getHours()) {
  if (hour < 12) return 'home.morning';
  if (hour < 18) return 'home.afternoon';
  return 'home.evening';
}

interface NewChatEmptyStateProps {
  isEmpty: boolean;
}

export function NewChatEmptyState({ isEmpty }: NewChatEmptyStateProps) {
  const isAgentMode = useUI((s) => s.inputMode) === 'agent';
  const t = useT();
  const resume = useResumeTask();

  return (
    <div
      className={cn(
        'absolute inset-0 pointer-events-none transition-opacity duration-200',
        isEmpty ? 'opacity-100' : 'opacity-0',
      )}
    >
      {/* The greeting sits above the centred composer. The intents used to be
          here too; they are under the composer now, where you read them after
          the field rather than instead of it. */}
      <div className="absolute inset-0 flex flex-col items-center justify-center pb-72">
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
          <>
            <h1 className="text-[28px] leading-tight font-semibold text-text-primary select-none">
              {t(greetingKey())}
            </h1>
            <p className="text-[28px] leading-tight font-semibold text-text-secondary select-none">
              {t('home.ask')}
            </p>
          </>
        )}

        {isAgentMode && <AgentByokNote />}
      </div>
    </div>
  );
}
