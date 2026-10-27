import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { AlertTriangle, Ban, Check, ChevronDown, Loader2, X } from 'lucide-react';
import { Streamdown } from 'streamdown';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { thinkingLabel } from '@/components/ai-elements/reasoning';
import { ShimmeringText } from '@/components/ui/shimmering-text';
import type { ToolActivity } from '@/hooks/useLiveToolActivity';
import { useUI } from '@/stores/ui';
import { displayName, type RlmWorker } from '@/stores/rlmWorkers';
import logoUrl from '@/assets/logo.svg';
import { Widget, summaryOf } from './CallToolScreen';
import { CinderpawMascot } from './mascot/CinderpawMascot';
import { ZoomableImage } from './ZoomableImage';

/** Pictures shown on the folded line, newest last (Claude's "+3" strip). */
const LINE_THUMBS = 3;

/** A step's pictures (screenshots, images it read), each opening full size. */
function Thumbs({ images, small }: { images: string[]; small?: boolean }) {
  return (
    <div className="flex shrink-0 items-center gap-1.5" data-testid="step-thumbs">
      {images.map((src, i) => (
        <ZoomableImage
          key={`${i}-${src.length}`}
          src={src}
          alt={`What the agent saw, picture ${i + 1}`}
          thumbClassName={small ? 'h-7 w-auto max-w-14 rounded-md object-cover' : 'h-16 w-auto max-w-32 rounded-md object-cover'}
        />
      ))}
    </div>
  );
}

/** Where a step is, for `firstLooks`: a site's host, or the app it named. */
function placeOf(subject: string): string {
  try { return new URL(/^[a-z]+:\/\//i.test(subject) ? subject : `https://${subject}`).hostname; } catch { return subject; }
}

/**
 * The steps whose picture is shown big: the first picture after the agent
 * arrives somewhere new (a site it opened, an app it named), like Claude's
 * first look at a page. Every later picture from the same place is a
 * thumbnail (Darius, 27 Oct: "o poza mare cu siteul, dupa care doar miniaturi").
 * ponytail: a place is what a browser or app step NAMED; a click that leads to
 * another site is not seen as a move. Read the page's url from the result if
 * that matters.
 */
export function firstLooks(steps: ToolActivity[]): Set<string> {
  const big = new Set<string>();
  let place = '';
  let shown: string | null = null;
  for (const a of steps) {
    if (a.subject && (a.tool === 'browser' || a.kind === 'desktop')) place = placeOf(a.subject);
    if (a.images?.length && place !== shown) {
      big.add(a.id);
      shown = place;
    }
  }
  return big;
}

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

/** Tools with no kind of their own that still have a plain phrase (running, done). */
const PHRASES: Record<string, [string, string]> = {
  // The question card is on screen; "Ask user" read like the app asking itself.
  ask_user: ['Waiting for your answer', 'Asked you'],
  context_compaction: ['Making room in this chat', 'Made room in this chat'],
  todo_write: ['Updating the plan', 'Updated the plan'],
  cowork_send: ['Messaging a teammate', 'Messaged a teammate'],
  rlm: ['Starting helpers', 'Started helpers'],
  // The built-in browser. Without it the line said "Browser".
  browser: ['Using the browser', 'Used the browser'],
};

/**
 * What a step did, in words: present tense while it runs, past once it is done
 * ("Searching the web", "Searched the web"). From the tool's kind and name,
 * never from its output. A tool with no phrase keeps its own name.
 */
export function stepTitle(a: Pick<ToolActivity, 'tool' | 'kind' | 'status' | 'artifact'> & Partial<Pick<ToolActivity, 'desktop' | 'images'>>): string {
  const now = a.status === 'running';
  const pick = (running: string, done: string) => (now ? running : done);
  // The built-in browser is a tool of its own (kind 'generic', not the web
  // search widget), and only its `screenshot` brings a picture back.
  if (a.tool === 'browser' && a.images?.length) return 'Took a picture of the page';
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
    case 'desktop':
      if (a.desktop?.action === 'screenshot') return pick('Taking a picture', 'Took a picture');
      return pick('Using an app', 'Used an app');
    case 'artifact': {
      const title = a.artifact?.title;
      // An edit is a change, often one part of a document drafted in parts.
      if (a.tool === 'artifact_edit') return title ? pick(`Changing ${title}`, `Changed ${title}`) : pick('Changing a document', 'Changed a document');
      return title ? pick(`Working on ${title}`, `Made ${title}`) : pick('Making an artifact', 'Made an artifact');
    }
    default: {
      const phrase = PHRASES[a.tool];
      if (phrase) return pick(phrase[0], phrase[1]);
      const name = a.tool.replace(/_/g, ' ');
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
  }
}

/**
 * Why a step failed, in plain words. The raw text ('Tool "read_file"
 * short-circuited: circuit_open: too many failures') is still in the step's
 * widget for whoever opens it; the row is for everyone.
 */
export function failureWords(error: string | null | undefined): string {
  const e = (error ?? '').toLowerCase();
  if (!e) return 'Did not work';
  if (e === 'stopped') return 'Stopped';
  if (e === 'no result') return 'No answer came back';
  if (/circuit_open|short-circuit/.test(e)) return 'Paused after failing a few times';
  if (/timed? ?out|timeout|deadline/.test(e)) return 'Took too long';
  if (/enoent|not found|no such file|404/.test(e)) return 'Not found';
  if (/eacces|eperm|permission|denied|forbidden|403/.test(e)) return 'Not allowed';
  if (/econnrefused|enotfound|network|unable to connect|fetch failed/.test(e)) return 'Could not connect';
  return 'Did not work';
}

/** The short count on the right of a step ("14 sources"), or what it was about. */
export function stepDetail(a: ToolActivity): string {
  if (a.status === 'failed') return failureWords(a.error);
  if (a.hits.length > 0) return plural(a.hits.length, 'source');
  if (a.files.length > 0) return plural(a.files.length, 'file');
  if (a.facts.length > 0) return plural(a.facts.length, 'memory', 'memories');
  // "Took a picture" said "Taking a picture" again on its right; the app is the news.
  if (a.desktop?.action === 'screenshot') return a.desktop.app;
  return summaryOf(a);
}

/**
 * What the steps did, as one past-tense sentence: "Searched the web, read a
 * page". It replaced "Worked for N seconds" with a green check, which timed the
 * tools only and read as "the answer is done" while the model was still
 * thinking or writing after them (UX lab, report item 5).
 */
export function doneSentence(steps: ToolActivity[]): string {
  const titles = steps.map((a) => stepTitle({ ...a, status: 'done' }));
  const said = [...new Set(titles)];
  // "Took a picture of the page 3 times", like Claude's "captured page 5 times".
  const times = (s: string) => titles.filter((t) => t === s).length;
  const shown = said.slice(0, 3)
    .map((s) => (times(s) > 1 ? `${s} ${times(s)} times` : s))
    .map((s, i) => (i === 0 ? s : s.charAt(0).toLowerCase() + s.slice(1)));
  const more = said.length - shown.length;
  const failed = steps.filter((a) => a.status === 'failed').length;
  return shown.join(', ') + (more > 0 ? `, and ${more} more` : '')
    + (failed > 0 ? ` (${failed === 1 ? 'one' : failed} did not work)` : '');
}

/**
 * What the model is thinking about right now, as a short line for the header:
 * the newest bold heading in its reasoning ("**Comparing prices**", which
 * OpenAI and Gemini summaries and many open models write), else the first
 * sentence of its newest paragraph. Claude's status line does this ("Estimating
 * sunset time by interpolating nearby dates"); "Thinking" said nothing.
 */
export function thoughtHeadline(text: string | null): string | null {
  if (!text) return null;
  const bold = [...text.matchAll(/\*\*([^*\n]{3,80})\*\*/g)].at(-1)?.[1]?.trim();
  if (bold) return bold.replace(/[:.]$/, '');
  const para = text.trim().split(/\n\s*\n/).at(-1)?.trim() ?? '';
  const first = para.split(/(?<=[.!?])\s/)[0]?.replace(/\s+/g, ' ').trim() ?? '';
  if (first.length < 3) return null;
  return first.length > 70 ? `${first.slice(0, 69).trimEnd()}…` : first.replace(/[.]$/, '');
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

/** A first look at a place, at the chat's width (Claude's "Captured page" picture). */
function FirstLook({ src }: { src: string }) {
  return (
    <ZoomableImage
      src={src}
      alt="What the agent saw when it got there"
      className="w-full"
      thumbClassName="block max-h-[30rem] w-full rounded-xl object-cover object-top"
    />
  );
}

/** One step: ring, what it did, its count. Click for the tool's own widget.
 *  `pop`: it arrived while the agent works, so it pops in (`.row-pop`).
 *  `big`: its first picture is a first look at a new place (`firstLooks`). */
function StepRow({ a, pop, big }: { a: ToolActivity; pop: boolean; big: boolean }) {
  // `null` is "nobody chose": the running step shows its widget, the rest fold.
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? a.status === 'running';
  return (
    <div className={pop ? 'row-pop' : undefined}>
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
        <span className="max-w-[45%] shrink-0 truncate text-2xs text-text-muted" title={stepDetail(a)}>
          {stepDetail(a)}
        </span>
      </button>
      {/* What it saw stays in view, folded or not: a picture is the step's proof. */}
      {a.images && a.images.length > 0 && (
        <div className="mb-1.5 ml-7 flex flex-col items-start gap-1.5">
          {big && <FirstLook src={a.images[0]!} />}
          {(big ? a.images.slice(1) : a.images).length > 0 && <Thumbs images={big ? a.images.slice(1) : a.images} />}
        </div>
      )}
      {open && (
        <div className="mb-1.5 ml-7">
          <Widget activity={a} flat />
        </div>
      )}
    </div>
  );
}

const HELPER_WORD: Record<RlmWorker['status'], string> = {
  running: 'working', completed: 'done', error: 'failed', cancelled: 'stopped',
};

/** One `rlm()` helper: its task, how it stands, for how long. Its answer is in WorkersCard. */
function HelperRow({ w, now }: { w: RlmWorker; now: number }) {
  const icon = w.status === 'running' ? <Loader2 size={16} className="shrink-0 animate-spin text-brand" />
    : w.status === 'completed' ? <Check size={16} className="shrink-0 text-success" />
    : w.status === 'cancelled' ? <Ban size={16} className="shrink-0 text-text-muted" />
    : <X size={16} className="shrink-0 text-error" />;
  return (
    <div className="flex items-center gap-3 py-1.5" data-testid="strip-helper">
      {icon}
      <span className="min-w-0 flex-1 truncate text-sm text-text-muted" title={w.name}>{displayName(w.name)}</span>
      <span className="shrink-0 text-2xs text-text-muted">
        {HELPER_WORD[w.status]} · {elapsedLabel((w.endedAt ?? now) - w.startedAt)}
      </span>
    </div>
  );
}

/**
 * The side activities worth a glance while the strip is folded (spec 7.5):
 * a memory lookup or an artifact in progress, and helpers still working.
 */
export function sideChips(steps: ToolActivity[], helpers: RlmWorker[]): string[] {
  const running = steps.filter((a) => a.status === 'running');
  const working = helpers.filter((w) => w.status === 'running').length;
  return [
    ...(running.some((a) => a.kind === 'memory') ? ['Using memory'] : []),
    ...(running.some((a) => a.kind === 'artifact') ? ['Generating artifact'] : []),
    ...(working > 0 ? [plural(working, 'helper')] : []),
  ];
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
 * The activity line (spec 7.5): what the agent did in this part of the turn,
 * as one quiet line over the answer. It says what is happening now and for how
 * long, with the newest pictures the agent took; open, it is a thin timeline of
 * each tool it ran and its reasoning. Replaces the card (27 Oct).
 *
 * The steps come from `toolActivity`, which the stream already records as
 * structured events, not from guessing steps out of the reasoning text.
 *
 * Folded, always, until the person opens it: while the agent works the line's
 * words change with each step and shimmer, like Claude's. It used to open by
 * itself while streaming and fold a beat after the answer; the steps and a
 * running tool's widget then pushed the answer down while it was being read.
 */
export function MessageChain({
  thinking, thinkingComplete, durationSec, steps, streaming, helpers = [], looks: given,
}: {
  /** null when the model gave none, or the person turned reasoning off. */
  thinking: string | null;
  thinkingComplete: boolean;
  durationSec: number | undefined;
  steps: ToolActivity[];
  streaming: boolean;
  /** This chat's `rlm()` helpers. Only the latest reply's last strip gets them:
   *  they belong to the session, and they run after the reply that started them. */
  helpers?: RlmWorker[];
  /** The steps whose picture is a first look, decided over the WHOLE reply
   *  (`firstLooks`): a reply drawn as several lines must not show a big picture
   *  on each. Left out, this line decides for its own steps. */
  looks?: Set<string>;
}) {
  // Folded until the person opens it, while the agent works too (27 Oct, his
  // ask, after Claude's line): the line itself says what happens now, and the
  // steps, the reasoning and each tool's widget are one click away.
  const [open, setOpen] = useState(false);
  // First drawn while the agent works, its rows arrive with a little bounce. A
  // chat opened again draws it as it is: nothing is replayed.
  const [live] = useState(streaming);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const now = useNow(streaming || helpers.some((w) => w.status === 'running'));

  if (thinking === null && steps.length === 0 && helpers.length === 0) return null;
  const chips = sideChips(streaming ? steps : [], helpers);

  const thinkingLive = streaming && thinking !== null && !thinkingComplete;
  const current = steps.find((a) => a.status === 'running') ?? steps[steps.length - 1];
  const count = steps.length > 0 ? plural(steps.length, 'step') : '';

  let title: string;
  let detail: string;
  if (streaming) {
    title = thinkingLive || (!current && thinking !== null)
      ? (thoughtHeadline(thinking) ?? 'Thinking')
      : current ? stepTitle(current) : 'Helpers';
    const since = steps.length > 0 ? Math.min(...steps.map((a) => a.startedAt)) : null;
    detail = [count, since !== null ? elapsedLabel(now - since) : ''].filter(Boolean).join(' · ');
  } else {
    title = steps.length === 0
      ? (thinking !== null ? thinkingLabel(false, durationSec) : 'Helpers')
      : doneSentence(steps);
    detail = count;
  }
  const failed = !streaming && steps.some((a) => a.status === 'failed');
  const looks = given ?? firstLooks(steps);
  // Folded, a first look stays in view at full width under the line, and the
  // other pictures ride on the line: the newest three, and how many more.
  const firstPictures = steps.flatMap((a) => (looks.has(a.id) && a.images?.length ? [a.images[0]!] : []));
  const others = steps.flatMap((a) => (looks.has(a.id) ? (a.images ?? []).slice(1) : (a.images ?? [])));
  const lineImages = open ? [] : others.slice(-LINE_THUMBS);
  const more = open ? 0 : others.length - lineImages.length;

  // 27 Oct, his ask: no card, no pill, no chips. The steps are a quiet line of
  // text over the answer (Claude's "Clicked, waited, captured page 4 times ›"),
  // and open into a thin timeline under it, so they read as part of the reply.
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid="activity-line">
      <div className="flex items-center gap-2">
        <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-2 py-1 text-left">
          {streaming ? <WorkingFigure /> : failed && <AlertTriangle size={14} className="shrink-0 text-warning" />}
          {/* Working, the words say what happens now and a light passes over
              them. Done, it is a quiet line of what happened, not a green
              "finished": the answer may still be arriving below it. */}
          {streaming
            ? <ShimmeringText text={title} className="min-w-0 truncate text-sm font-medium" />
            : <span className="min-w-0 truncate text-sm text-text-muted group-hover:text-text-primary">{title}</span>}
          {/* What also runs ("Using memory") is words on the line, not a chip. */}
          {[...chips, detail].filter(Boolean).length > 0 && (
            <span className="shrink-0 text-2xs text-text-muted">{[...chips, detail].filter(Boolean).join(' · ')}</span>
          )}
          <ChevronDown size={14} className={cn('shrink-0 text-text-muted transition-transform', open ? 'rotate-0' : '-rotate-90')} />
        </CollapsibleTrigger>
        {more > 0 && <span className="shrink-0 text-2xs text-text-muted">+{more}</span>}
        {lineImages.length > 0 && <Thumbs images={lineImages} small />}
      </div>
      {!open && firstPictures.length > 0 && (
        // Two places in one line sit side by side: stacked, they were a wall.
        <div className={cn('mb-1 mt-1.5 grid gap-2', firstPictures.length > 1 && 'grid-cols-2')}>
          {firstPictures.map((src, i) => <FirstLook key={`${i}-${src.length}`} src={src} />)}
        </div>
      )}
      <CollapsibleContent
        className={cn(
          'ml-[7px] overflow-hidden border-l border-border-subtle pl-4 outline-none',
          'data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down',
        )}
      >
        {steps.map((a) => <StepRow key={a.id} a={a} pop={live && streaming} big={looks.has(a.id)} />)}
        {helpers.map((w) => <HelperRow key={w.childId} w={w} now={now} />)}
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
