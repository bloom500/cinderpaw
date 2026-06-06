import { useEffect, useRef, useState } from 'react';
import type { StreamStatus, AgentPhase } from '@/stores/chat';
import type { MascotState } from './frames';

export const DONE_HOLD_MS = 1200;

export interface MascotInputs {
  streamStatus: StreamStatus;
  agentPhase: AgentPhase;
  isUserTyping: boolean;
}

/** Pure-ish mapping from app state to mascot state, with a transient `done`. */
export function useMascotState({ streamStatus, agentPhase, isUserTyping }: MascotInputs): MascotState {
  const [doneActive, setDoneActive] = useState(false);
  const prevStatus = useRef<StreamStatus>(streamStatus);

  useEffect(() => {
    // Fire `done` only on the transition INTO 'done'.
    if (streamStatus === 'done' && prevStatus.current !== 'done') {
      setDoneActive(true);
      const id = setTimeout(() => setDoneActive(false), DONE_HOLD_MS);
      prevStatus.current = streamStatus;
      return () => clearTimeout(id);
    }
    // Any non-done status cancels a held `done`.
    if (streamStatus !== 'done') setDoneActive(false);
    prevStatus.current = streamStatus;
  }, [streamStatus]);

  if (doneActive) return 'done';
  if (streamStatus === 'streaming') {
    return agentPhase === 'calling' ? 'calling' : 'thinking';
  }
  if (isUserTyping) return 'typing';
  return 'idle';
}
