import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  AlertTriangle, Brain, Database, FileBox, FileText, Globe, Monitor, Sparkles, SquareTerminal, Wrench,
  type LucideIcon,
} from 'lucide-react';
import { Streamdown } from 'streamdown';
import {
  ChainOfThought, ChainOfThoughtContent, ChainOfThoughtHeader, ChainOfThoughtStep,
} from '@/components/ai-elements/chain-of-thought';
import { thinkingLabel } from '@/components/ai-elements/reasoning';
import { ShimmeringText } from '@/components/ui/shimmering-text';
import type { ToolActivity, ToolKind } from '@/hooks/useLiveToolActivity';
import { Widget, summaryOf } from './CallToolScreen';

/** How long the finished answer is on screen before the steps fold away. */
const FOLD_DELAY_MS = 1000;

/** One icon per kind. A Record, so a new kind added to ToolKind fails tsc here until it has one. */
const ICON: Record<ToolKind, LucideIcon> = {
  agent: Sparkles,
  browser: Globe,
  files: FileText,
  terminal: SquareTerminal,
  memory: Database,
  desktop: Monitor,
  artifact: FileBox,
  generic: Wrench,
};

/** No Streamdown plugins, for the same bundle reason as reasoning.tsx. */
const NO_PLUGINS = {};

function ThinkingText({ text, live }: { text: string; live: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  // Follow the newest line inside the box, so the person reads the thought as
  // it arrives without the page moving under them.
  useEffect(() => {
    if (live && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [text, live]);
  return (
    <div
      ref={box}
      className={cn('text-xs text-muted-foreground', live && 'max-h-40 overflow-y-auto thin-scrollbar')}
    >
      <Streamdown plugins={NO_PLUGINS}>{text}</Streamdown>
    </div>
  );
}

/**
 * What the agent did before it answered, as steps: each tool it ran, and its
 * reasoning. Replaces the separate reasoning block and tool rows, which showed
 * the same turn as two unrelated things.
 *
 * The steps come from `toolActivity`, which the stream already records as
 * structured events, not from guessing steps out of the reasoning text.
 *
 * Open while the turn streams, so the steps arrive live. Folds itself a beat
 * after the WHOLE answer is written, never when the answer merely starts (that
 * was the bug that made the old block vanish mid-read). A click reopens it.
 */
export function MessageChain({
  thinking, thinkingComplete, durationSec, steps, streaming,
}: {
  /** null when the model gave none, or the person turned reasoning off. */
  thinking: string | null;
  thinkingComplete: boolean;
  durationSec: number | undefined;
  steps: ToolActivity[];
  streaming: boolean;
}) {
  const [open, setOpen] = useState(streaming);
  const wasStreaming = useRef(streaming);

  useEffect(() => {
    const before = wasStreaming.current;
    wasStreaming.current = streaming;
    if (streaming && !before) setOpen(true);
    if (before && !streaming) {
      const t = setTimeout(() => setOpen(false), FOLD_DELAY_MS);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [streaming]);

  if (thinking === null && steps.length === 0) return null;

  const count = steps.length > 0 ? `${steps.length} step${steps.length === 1 ? '' : 's'}` : '';
  const title = streaming
    ? <ShimmeringText text="Thinking…" duration={1.4} />
    : [thinking !== null ? thinkingLabel(false, durationSec) : '', count].filter(Boolean).join(' · ');

  return (
    <ChainOfThought open={open} onOpenChange={setOpen}>
      <ChainOfThoughtHeader>{title}</ChainOfThoughtHeader>
      <ChainOfThoughtContent>
        {steps.map((a) => (
          <ChainOfThoughtStep
            key={a.id}
            icon={a.status === 'failed' ? AlertTriangle : ICON[a.kind]}
            label={a.tool.replace(/_/g, ' ')}
            description={a.status === 'failed' ? (a.error ?? 'failed') : summaryOf(a)}
            status={a.status === 'running' ? 'active' : 'complete'}
          >
            <Widget activity={a} flat />
          </ChainOfThoughtStep>
        ))}
        {/* ponytail: reasoning is drawn after the tools. The stream keeps only the
            latest segment's reasoning, which is the one after the last tool, so
            this is its real position. Interleaving every segment would need the
            stream to keep each one; add that if earlier reasoning is missed. */}
        {thinking !== null && (
          <ChainOfThoughtStep
            icon={Brain}
            label={streaming && !thinkingComplete ? 'Thinking' : 'Reasoning'}
            status={streaming && !thinkingComplete ? 'active' : 'complete'}
          >
            {/* While it streams, the reasoning grows inside a box of fixed
                height that scrolls itself, instead of pushing the answer and
                everything under it down a line at a time: that push, with the
                page following, read as the whole transcript bouncing. Once
                the thinking is complete the box opens to its full height. */}
            <ThinkingText text={thinking} live={streaming && !thinkingComplete} />
          </ChainOfThoughtStep>
        )}
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
}
