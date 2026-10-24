import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useChat, type AgentPhase } from '@/stores/chat';
import { useModel } from '@/stores/model';
import { onCloudModel, useCinderpawStore } from '@/stores/cinderpaw';
import { events, type StreamProgressEvent } from '@/lib/tauri';
import { MessageLoading } from '@/components/ui/message-loading';
import { kindOf } from '@/hooks/useLiveToolActivity';
import { stepTitle } from './MessageChain';

interface StreamingIndicatorProps {
  phase?: AgentPhase;
  tool?: string | null;
  /** Drawn in place of the hopping dots (the chat passes the logo head). */
  icon?: ReactNode;
}

/** #16: after this long with zero tokens, explain WHY nothing is happening. */
const SLOW_START_MS = 5_000;
/** A long wait changes its line this often, so it never looks frozen. */
const WAIT_LINE_MS = 7_000;

/** Twenty lines for a long wait, one every few seconds, starting at a random one. */
export const WAIT_LINES = [
  'Thinking it through…', 'Gathering the pieces…', 'Reading between the lines…',
  'Lining up the details…', 'Checking my work…', 'Putting my thoughts in order…',
  'Weighing a few options…', 'Still on it…', 'Connecting the dots…',
  'Sorting out what matters…', 'Turning it over once more…', 'Finding the right words…',
  'Making sure it adds up…', 'Sharpening the answer…', 'Following one more thread…',
  'Picking the best route…', 'Tidying up my notes…', 'Taking care with this one…',
  'Keeping the embers warm…', 'Thanks for waiting…',
] as const;
const LOAD_HINT = 'Thinking… The first response after loading a model can take a while.';

function phaseLabel(phase: AgentPhase, tool?: string | null): string {
  // The step's own words ("Searching the web"), the same as its row in the
  // reply. A tool id here read "Calling ask user…" while it waited for the person.
  if (phase === 'calling' && tool) return `${stepTitle({ tool, kind: kindOf(tool), status: 'running', artifact: null })}…`;
  if (phase === 'calling') return 'Working…';
  // After a tool returns the model is reading the result, which is thinking.
  if (phase === 'processing') return 'Thinking…';
  if (phase === 'reading') return 'Reading…';
  if (phase === 'searching') return 'Searching…';
  if (phase === 'building') return 'Building…';
  if (phase === 'writing') return 'Writing…';
  return 'Thinking…';
}

function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function progressLabel(p: StreamProgressEvent): string {
  if (p.phase === 'prefill') return Number.isFinite(p.elapsedMs) && p.elapsedMs >= 0
    ? `Reading your message · ${formatElapsed(p.elapsedMs)}` : 'Reading your message…';
  if (Number.isFinite(p.tokensPerSec) && p.tokensPerSec > 0.5) return `Writing · ${p.tokensPerSec.toFixed(1)} tok/s`;
  return 'Writing…';
}

export function StreamingIndicator({ phase = 'thinking', tool, icon }: StreamingIndicatorProps) {
  const sessionId = useChat((s) => s.sessionId);
  const [visible, setVisible] = useState(true);
  // `baseLabel` comes from phase transitions (model load, calling, processing) — faded.
  // `progress` overrides it during 'thinking' phase with live heartbeat data — no fade.
  const [baseLabel, setBaseLabel] = useState(() => phaseLabel(phase, tool));
  const [progress, setProgress] = useState<StreamProgressEvent | null>(null);
  const [slowStart, setSlowStart] = useState(false);
  // #16: the very first message after install rides on a model load and a
  // long prompt prefill — minutes of silence on CPU-only machines, which
  // looks exactly like a hang. Surface the load progress while the model
  // loads, and an explanatory line when no token has arrived for a while.
  const isModelLoading = useModel((s) => s.isLoading);
  const loadProgress = useModel((s) => s.loadProgress);
  // A cloud model is never "loaded": on Claude the hint blamed a load that
  // did not happen. Unknown config keeps the hint (a fresh local install).
  const isCloud = useCinderpawStore(onCloudModel);

  // Which wait line is showing: a random start, then one step every few seconds.
  const [waitLine, setWaitLine] = useState(0);
  // The load hint is said once per chat: after that the model is loaded.
  const waitStarted = useRef(false);
  useEffect(() => { waitStarted.current = false; }, [sessionId]);
  useEffect(() => {
    setSlowStart(false);
    if (phase !== 'thinking') return;
    let step: ReturnType<typeof setInterval> | undefined;
    const t = setTimeout(() => {
      setWaitLine(Math.floor(Math.random() * WAIT_LINES.length));
      setSlowStart(true);
      step = setInterval(() => setWaitLine((i) => i + 1), WAIT_LINE_MS);
    }, SLOW_START_MS);
    return () => { clearTimeout(t); clearInterval(step); };
  }, [sessionId, phase]);

  // Progress heartbeats from the agent's inference (filtered cinderpaw://agent-output).
  useEffect(() => {
    setProgress(null);
    // See App.tsx: a listener whose `listen()` resolves after unmount must be
    // released on arrival, or it stays attached to a dead component forever.
    let cancelled = false;
    const unlistens: Array<() => void> = [];
    const keep = (fn: () => void) => { if (cancelled) fn(); else unlistens.push(fn); };
    const set = (e: StreamProgressEvent) => {
      if (!cancelled && phase === 'thinking' && e.sessionId === sessionId) setProgress(e);
    };
    events.onStreamProgress.listen(set).then(keep);
    return () => { cancelled = true; unlistens.forEach((u) => u()); };
  }, [sessionId, phase]);

  // Phase transitions → fade the base label. Progress ticks don't touch this.
  useEffect(() => {
    setVisible(false);
    const swap = setTimeout(() => {
      if (isModelLoading) {
        const pct = loadProgress ? ` ${Math.round(loadProgress.percentage)}%` : '';
        setBaseLabel(`Loading model…${pct}`);
      } else if (slowStart && phase === 'thinking') {
        // A local model may really be loading: say so first, then the lines.
        // A cloud model is never "loaded", so it goes straight to the lines.
        const firstLoad = !isCloud && !waitStarted.current;
        waitStarted.current = true;
        setBaseLabel(firstLoad ? LOAD_HINT : WAIT_LINES[waitLine % WAIT_LINES.length]);
      } else {
        setBaseLabel(phaseLabel(phase, tool));
      }
      setVisible(true);
    }, 120);
    return () => clearTimeout(swap);
  }, [phase, tool, isModelLoading, loadProgress, slowStart, isCloud, waitLine]);

  // Live label: progress wins during thinking; otherwise base label.
  const label = progress && progress.sessionId === sessionId && phase === 'thinking' && !isModelLoading
    ? progressLabel(progress)
    : baseLabel;

  return (
    <div role="status" className="flex items-center gap-2 px-4 py-2 text-text-muted text-xs">
      {/* Hopping dots rather than three that pulse in place: movement reads as
          "working" at a glance, a pulse reads as "waiting for something". */}
      {icon ?? <MessageLoading className="shrink-0" />}
      <span
        style={{ transition: 'opacity 120ms ease' }}
        className={visible ? 'opacity-100' : 'opacity-0'}
      >
        {label}
      </span>
    </div>
  );
}
