import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { AlertTriangle, Check, ChevronDown, Loader2 } from 'lucide-react';
import { Streamdown } from 'streamdown';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { thinkingLabel } from '@/components/ai-elements/reasoning';
import type { ToolActivity } from '@/hooks/useLiveToolActivity';
import { useUI } from '@/stores/ui';
import logoUrl from '@/assets/logo.svg';
import { Widget, summaryOf } from './CallToolScreen';
import { CinderpawMascot } from './mascot/CinderpawMascot';

/** How long the finished answer is on screen before the steps fold away. */
const FOLD_DELAY_MS = 1000;

/** No Streamdown plugins, for the same bundle reason as reasoning.tsx. */
const NO_PLUGINS = {};

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "12s", "1m 12s". */
export function elapsedLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * What a step did, in words: present tense while it runs, past once it is done
 * ("Searching the web", "Searched the web"). From the tool's kind and name,
 * never from its output. A tool with no phrase keeps its own name.
 */
export function stepTitle(a: Pick<ToolActivity, 'tool' | 'kind' | 'status' | 'artifact'>): string {
  const now = a.status === 'running';
  const pick = (running: string, done: string) => (now ? running : done);
  switch (a.kind) {
    case 'browser':
      if (/^(web_search|deep_research)/.test(a.tool)) return pick('Searching the web', 'Searched the web');
      if (/^(read_webpage|fetch_url|http_request)/.test(a.tool)) return pick('Reading a page', 'Read a page');
      return pick('Using the browser', 'Used the browser');
    case 'files':
      if (/write|edit|create|delete|move/.test(a.tool)) return pick('Writing files', 'Wrote files');
      return pick('Reading files', 'Read files');
    case 'terminal': return pick('Running a command', 'Ran a command');
    case 'memory':   return pick('Checking memory', 'Checked memory');
    case 'agent':    return pick('Asking a helper', 'Asked a helper');
    case 'desktop':  return pick('Using an app', 'Used an app');
    case 'artifact': {
      const title = a.artifact?.title;
      return title ? pick(`Working on ${title}`, `Made ${title}`) : pick('Making an artifact', 'Made an artifact');
    }
    default: {
      const name = a.tool.replace(/_/g, ' ');
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
  }
}

/** The short count on the right of a step ("14 sources"), or what it was about. */
export function stepDetail(a: ToolActivity): string {
  if (a.status === 'failed') return a.error ?? 'Failed';
  if (a.hits.length > 0) return plural(a.hits.length, 'source');
  if (a.files.length > 0) return plural(a.files.length, 'file');
  if (a.facts.length > 0) return plural(a.facts.length, 'memory', 'memories');
  return summaryOf(a);
}

/**
 * How long the steps took, first start to last end, in whole seconds (at least
 * one). Null when a step never recorded its end, so nothing made up is shown.
 */
export function workedSeconds(steps: ToolActivity[]): number | null {
  if (steps.length === 0 || steps.some((a) => a.endedAt === null)) return null;
  const start = Math.min(...steps.map((a) => a.startedAt));
  const end = Math.max(...steps.map((a) => a.endedAt!));
  return Math.max(1, Math.round((end - start) / 1000));
}

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

/** Seconds since `since`, re-read once a second while `live`. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [live]);
  return now;
}

function StatusRing({ status }: { status: ToolActivity['status'] }) {
  if (status === 'running') return <Loader2 size={16} className="shrink-0 animate-spin text-brand" />;
  if (status === 'failed') return <AlertTriangle size={16} className="shrink-0 text-warning" />;
  return <Check size={16} className="shrink-0 text-success" />;
}

/** One step: ring, what it did, its count. Click for the tool's own widget. */
function StepRow({ a }: { a: ToolActivity }) {
  // `null` is "nobody chose": the running step shows its widget, the rest fold.
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? a.status === 'running';
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setChoice(!open)}
        className="flex w-full items-center gap-3 py-1.5 text-left"
      >
        <StatusRing status={a.status} />
        <span className={cn('min-w-0 flex-1 truncate text-sm', a.status === 'running' ? 'font-medium text-text-primary' : 'text-text-muted')}>
          {stepTitle(a)}
        </span>
        <span className="max-w-[45%] shrink-0 truncate text-2xs text-text-disabled" title={stepDetail(a)}>
          {stepDetail(a)}
        </span>
      </button>
      {open && (
        <div className="mb-1.5 ml-7">
          <Widget activity={a} flat />
        </div>
      )}
    </div>
  );
}

/** The clay mascot at work, 48 px; the logo head when the mascot is turned off. */
function WorkingFigure() {
  const mascot = useUI((s) => s.mascotEnabled);
  if (!mascot) return <img src={logoUrl} alt="" className="h-8 w-8 shrink-0" />;
  return (
    <span aria-hidden className="relative -my-2 h-12 w-12 shrink-0 overflow-hidden">
      <span className="absolute left-0 top-0 origin-top-left scale-[0.375]">
        <CinderpawMascot state="calling" />
      </span>
    </span>
  );
}

/**
 * The Activity Strip (spec 7.5): what the agent did in this part of the turn,
 * as one card. Its header says what is happening now and for how long; the
 * rows are each tool it ran and its reasoning. Replaces the step card.
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
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const now = useNow(streaming);

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

  const thinkingLive = streaming && thinking !== null && !thinkingComplete;
  const current = steps.find((a) => a.status === 'running') ?? steps[steps.length - 1];
  const count = steps.length > 0 ? plural(steps.length, 'step') : '';

  let title: string;
  let detail: string;
  if (streaming) {
    title = thinkingLive || !current ? 'Thinking' : stepTitle(current);
    const since = steps.length > 0 ? Math.min(...steps.map((a) => a.startedAt)) : null;
    detail = [count, since !== null ? elapsedLabel(now - since) : ''].filter(Boolean).join(' · ');
  } else {
    const worked = workedSeconds(steps);
    title = steps.length === 0
      ? thinkingLabel(false, durationSec)
      : worked !== null ? `Worked for ${plural(worked, 'second')}` : 'Worked';
    detail = count;
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="overflow-hidden rounded-2xl border border-border-default bg-bg-surface"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left">
        {streaming ? (
          <WorkingFigure />
        ) : (
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
            <Check size={12} />
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">{title}</span>
        {detail && <span className="shrink-0 text-2xs text-text-disabled">{detail}</span>}
        <ChevronDown size={16} className={cn('shrink-0 text-text-muted transition-transform', open && 'rotate-180')} />
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          'overflow-hidden border-t border-border-subtle px-3.5 py-1.5 outline-none',
          'data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down',
        )}
      >
        {steps.map((a) => <StepRow key={a.id} a={a} />)}
        {/* ponytail: reasoning is drawn after the tools. The stream keeps only the
            latest segment's reasoning, which is the one after the last tool, so
            this is its real position. Interleaving every segment would need the
            stream to keep each one; add that if earlier reasoning is missed. */}
        {thinking !== null && (
          <div>
            <button
              type="button"
              aria-expanded={thinkingLive || reasoningOpen}
              onClick={() => setReasoningOpen((v) => !v)}
              className="flex w-full items-center gap-3 py-1.5 text-left"
            >
              {thinkingLive
                ? <Loader2 size={16} className="shrink-0 animate-spin text-brand" />
                : <Check size={16} className="shrink-0 text-success" />}
              <span className={cn('flex-1 text-sm', thinkingLive ? 'font-medium text-text-primary' : 'text-text-muted')}>
                {thinkingLive ? 'Thinking' : 'Reasoning'}
              </span>
            </button>
            {/* While it streams, the reasoning grows inside a box of fixed
                height that scrolls itself, instead of pushing the answer and
                everything under it down a line at a time. Once complete it is
                one click away, at full height. */}
            {(thinkingLive || reasoningOpen) && (
              <div className="mb-1.5 ml-7">
                <ThinkingText text={thinking} live={thinkingLive} />
              </div>
            )}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
