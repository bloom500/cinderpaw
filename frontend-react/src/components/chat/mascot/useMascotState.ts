import { useEffect, useRef, useState } from 'react';
import type { StreamStatus, AgentPhase } from '@/stores/chat';
import type { MascotState } from './frames';

export const DONE_HOLD_MS = 1200;
export const COOL_HOLD_MS = DONE_HOLD_MS * 2;
export const EXCITED_HOLD_MS = 800;

export interface MascotInputs {
  streamStatus: StreamStatus;
  agentPhase: AgentPhase;
  isUserTyping: boolean;
}

export function useMascotState({ streamStatus, agentPhase, isUserTyping }: MascotInputs): MascotState {
  const [doneActive, setDoneActive] = useState(false);
  const [excitedActive, setExcitedActive] = useState(false);
  const prevStatus = useRef<StreamStatus>(streamStatus);
  const idleTier = useRef<number>(0);

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

  if (doneActive) return 'done';
  if (excitedActive) return 'excited';
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
  return 'idle';
}
