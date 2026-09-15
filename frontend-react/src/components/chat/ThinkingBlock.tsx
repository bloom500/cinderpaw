import { useState } from 'react';
import { Brain, ChevronRight } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ShimmeringText } from '@/components/ui/shimmering-text';
import { useChat } from '@/stores/chat';
import { cn } from '@/lib/utils';

interface Props {
  id: string;
  content: string;
  /** Undefined when nobody measured it, e.g. a conversation reopened from disk. */
  durationMs?: number;
  active: boolean;
}

/**
 * What the collapsed block says. It said "Thought for 0s" on every reopened
 * conversation, because the duration is not saved with it: a number nobody
 * measured, presented as a measurement. Unknown is said as unknown.
 */
export function thinkingLabel(durationMs?: number): string {
  if (durationMs === undefined) return 'Reasoning';
  const s = Math.round(durationMs / 1000);
  if (s < 1) return 'Thought for a moment';
  if (s < 60) return `Thought for ${s} ${s === 1 ? 'second' : 'seconds'}`;
  return `Thought for ${Math.floor(s / 60)} min ${s % 60} s`;
}

/**
 * The model's reasoning, after AI Elements' Reasoning pattern without its
 * markdown stack: open while the model thinks, so the wait shows what it is
 * spent on; folded once the answer starts, so the answer is what you read.
 * Either way one click flips it, and the choice made after the answer sticks.
 */
export function ThinkingBlock({ id, content, durationMs, active }: Props) {
  const expanded = useChat((s) => !!s.expandedThinkingIds[id]);
  const toggle = useChat((s) => s.toggleThinking);
  const [openWhileThinking, setOpenWhileThinking] = useState(true);

  const open = active ? openWhileThinking : expanded;
  const onOpenChange = (next: boolean) => {
    if (active) setOpenWhileThinking(next);
    else if (next !== expanded) toggle(id);
  };

  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="mb-3">
      <CollapsibleTrigger className="flex items-center gap-2 text-sm text-text-muted hover:text-text-secondary">
        <Brain size={14} aria-hidden />
        {active ? <ShimmeringText text="Thinking" /> : <span>{thinkingLabel(durationMs)}</span>}
        <ChevronRight size={14} aria-hidden className={cn('transition-transform duration-150', open && 'rotate-90')} />
      </CollapsibleTrigger>
      <CollapsibleContent className="data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0">
        {/* Capped and scrollable. A reasoning model can emit tens of thousands
            of characters of thinking, and unbounded that pushed the answer, the
            part the user actually wants, far below the fold. */}
        <div className="mt-2 pl-3 border-l border-border-subtle text-sm text-text-muted whitespace-pre-wrap font-mono max-h-80 overflow-y-auto thin-scrollbar">
          {content}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
