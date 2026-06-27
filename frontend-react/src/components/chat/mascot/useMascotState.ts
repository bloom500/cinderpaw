import { useEffect, useRef, useState } from 'react';
import type { StreamStatus, AgentPhase } from '@/stores/chat';
import { useAskUser } from '@/stores/askUser';
import { useFeralStore } from '@/stores/feral';
import type { MascotState } from './frames';

export const DONE_HOLD_MS = 1200;
export const COOL_HOLD_MS = DONE_HOLD_MS * 2;
export const EXCITED_HOLD_MS = 800;
export const ERROR_HOLD_MS = 1600;

// Idle personality. The state machine only ever resolves a handful of states
// during real use (idle/typing/thinking/calling/done), so the dozen expressive
// hand-drawn states never got seen. While the mascot is genuinely at rest it
// now plays a random one of these for a beat, then settles back to idle — the
// creature feels alive instead of looping the same 5 frames.
const AMBIENT: MascotState[] = [
  'wave', 'stretching', 'gaming', 'love', 'cool', 'curious', 'surprised', 'celebrate', 'running',
];
const AMBIENT_HOLD_MS = 2600;          // how long a personality beat plays
const AMBIENT_GAP_MIN_MS = 6000;       // rest between beats (randomised)
const AMBIENT_GAP_MAX_MS = 13000;

export interface MascotInputs {
  streamStatus: StreamStatus;
  agentPhase: AgentPhase;
  isUserTyping: boolean;
}

export function useMascotState({ streamStatus, agentPhase, isUserTyping }: MascotInputs): MascotState {
  const [doneActive, setDoneActive] = useState(false);
  const [excitedActive, setExcitedActive] = useState(false);
  const [errorActive, setErrorActive] = useState(false);
  const [ambient, setAmbient] = useState<MascotState | null>(null);
  const prevStatus = useRef<StreamStatus>(streamStatus);
  const idleTier = useRef<number>(0);
  // #23: the two moments the mascot previously had nothing to say about —
  // "I asked YOU a question" (ask_user pending → curious, looking at the
  // user) and "my agent process is down" (sidecar offline → asleep).
  const askPending = useAskUser((s) => s.pending !== null);
  const agentOffline = useFeralStore((s) => s.offline);

  const isExcitedTransition = streamStatus === 'streaming' && prevStatus.current !== 'streaming' && idleTier.current > 0;

  useEffect(() => {
    if (streamStatus === 'done' && prevStatus.current !== 'done') {
      setDoneActive(true);
      const id = setTimeout(() => setDoneActive(false), DONE_HOLD_MS);
      prevStatus.current = streamStatus;
      return () => clearTimeout(id);
    }
    if (streamStatus !== 'done') setDoneActive(false);
    prevStatus.current = streamStatus;
  }, [streamStatus]);

  useEffect(() => {
    if (isExcitedTransition) {
      setExcitedActive(true);
      const id = setTimeout(() => setExcitedActive(false), EXCITED_HOLD_MS);
      return () => clearTimeout(id);
    }
    if (streamStatus !== 'streaming') setExcitedActive(false);
    if (streamStatus === 'idle') idleTier.current = Math.min(idleTier.current + 1, 3);
    else idleTier.current = 0;
  }, [streamStatus, isExcitedTransition]);

  // A failed run gets a brief "uh-oh" instead of silently going idle.
  useEffect(() => {
    if (streamStatus !== 'error') { setErrorActive(false); return; }
    setErrorActive(true);
    const id = setTimeout(() => setErrorActive(false), ERROR_HOLD_MS);
    return () => clearTimeout(id);
  }, [streamStatus]);

  // Only fire personality beats when nothing else has something to say.
  const restful =
    !agentOffline && !askPending && !isUserTyping &&
    streamStatus !== 'streaming' && streamStatus !== 'error' &&
    !doneActive && !excitedActive && !errorActive;

  useEffect(() => {
    if (!restful) { setAmbient(null); return; }
    let live = true;
    let t: ReturnType<typeof setTimeout>;
    const rest = () => {
      t = setTimeout(play, AMBIENT_GAP_MIN_MS + Math.random() * (AMBIENT_GAP_MAX_MS - AMBIENT_GAP_MIN_MS));
    };
    const play = () => {
      if (!live) return;
      setAmbient(AMBIENT[Math.floor(Math.random() * AMBIENT.length)]);
      t = setTimeout(() => { setAmbient(null); rest(); }, AMBIENT_HOLD_MS);
    };
    rest();
    return () => { live = false; clearTimeout(t); };
  }, [restful]);

  if (agentOffline) return 'sleep';
  if (errorActive) return 'error';
  if (doneActive) return 'done';
  if (excitedActive) return 'excited';
  if (askPending) return 'curious';
  if (streamStatus === 'streaming') {
    switch (agentPhase) {
      case 'calling':   return 'calling';
      case 'reading':   return 'reading';
      case 'searching': return 'searching';
      case 'building':  return 'building';
      case 'writing':   return 'writing';
      default:          return 'thinking';
    }
  }
  if (isUserTyping) return 'typing';
  if (ambient) return ambient;
  return 'idle';
}
