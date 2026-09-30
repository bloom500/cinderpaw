import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { CinderpawMascot } from './mascot/CinderpawMascot';
import { elapsedLabel, stepTitle } from './MessageChain';
import { kindOf } from '@/hooks/useLiveToolActivity';
import { Markdown } from '@/lib/markdown';
import { stripTeammates, type StripTeammate } from '@/lib/coworkStrip';
import { useCoworkTranscript } from '@/stores/coworkTranscript';
import { useUI } from '@/stores/ui';
import logoUrl from '@/assets/logo.svg';

function Clock({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return <span className="tabular-nums">{elapsedLabel(now - since)}</span>;
}

function Figure({ working }: { working: boolean }) {
  const mascot = useUI((s) => s.mascotEnabled);
  if (!mascot) return <img src={logoUrl} alt="" className="h-7 w-7 shrink-0" />;
  // The teammate's own colour comes with the mascot task (spec 7.5); same clay for now.
  return (
    <span aria-hidden className="relative -my-1 h-9 w-9 shrink-0 overflow-hidden">
      <span className="absolute left-0 top-0 origin-top-left scale-[0.28125]">
        <CinderpawMascot state={working ? 'typing' : 'done'} />
      </span>
    </span>
  );
}

function Card({ t }: { t: StripTeammate }) {
  const markSeen = useCoworkTranscript((s) => s.markSeen);
  const [viewing, setViewing] = useState(false);
  const working = t.state === 'working';
  return (
    <Popover
      onOpenChange={(open) => {
        // Read once the person has opened it and closed the popover again, so
        // the card does not vanish from under them while they read.
        if (!open && viewing) { markSeen(t.exchangeId); setViewing(false); }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${t.name}, ${working ? 'working' : 'has an answer'}`}
          className="flex min-w-0 max-w-56 shrink-0 items-center gap-2 rounded-2xl border border-border-default bg-bg-elevated py-1.5 pl-1.5 pr-3 text-left hover:bg-text-primary/5"
        >
          <Figure working={working} />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium text-text-primary">{t.name}</span>
            <span className="truncate text-2xs text-text-muted">
              {working ? <>Working · <Clock since={t.since} /></> : 'Answered'}
            </span>
          </span>
          {!working && <span aria-hidden className="ml-1 h-2 w-2 shrink-0 rounded-full bg-brand" />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-3.5">
        <p className="text-sm font-semibold text-text-primary">{t.name}</p>
        {t.task && (
          <p className="mt-1 line-clamp-3 text-sm text-text-muted">
            {working ? 'Working on: ' : 'Asked: '}{t.task}
          </p>
        )}
        {t.tools.length > 0 && (
          <ul aria-label="Recent progress" className="mt-2.5 flex flex-col gap-1">
            {t.tools.map((tool, i) => (
              <li key={`${tool.name}-${i}`} className="flex items-center gap-2 text-2xs text-text-muted">
                {tool.done ? <Check size={12} className="text-brand" /> : <Loader2 size={12} className="animate-spin" />}
                {stepTitle({ tool: tool.name, kind: kindOf(tool.name), status: tool.done ? 'done' : 'running', artifact: null })}
              </li>
            ))}
          </ul>
        )}
        {!working && t.answer && (viewing ? (
          <div className="mt-3 max-h-72 overflow-auto rounded-lg border border-border-subtle bg-bg-surface px-3 py-2 text-sm">
            <Markdown>{t.answer}</Markdown>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setViewing(true)}
            className="mt-3 h-8 rounded-lg bg-brand px-3.5 text-sm font-medium text-brand-foreground hover:bg-brand/90"
          >
            View answer
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The Coworker Strip (spec 7.5): teammate cards at the top of the chat, only
 * while one is working or has an answer the person has not opened. A card
 * opens a popover with what it is doing, its recent steps, and View answer.
 */
export function CoworkerStrip() {
  const exchanges = useCoworkTranscript((s) => s.exchanges);
  const threadId = useCoworkTranscript((s) => s.activeThreadId);
  const seen = useCoworkTranscript((s) => s.seenAnswers);
  const teammates = useMemo(() => stripTeammates(exchanges, threadId, seen), [exchanges, threadId, seen]);
  if (teammates.length === 0) return null;
  return (
    <div role="region" aria-label="Teammates" className="mx-auto w-full max-w-3xl shrink-0 px-4 pt-3">
      <div className="flex gap-2 overflow-x-auto pb-1">
        {teammates.map((t) => <Card key={t.agentId} t={t} />)}
      </div>
    </div>
  );
}
