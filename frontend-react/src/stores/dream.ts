/**
 * Dream Cycle UI state.
 *
 * `dreaming` is true while the RSI evolutionary engine runs a background
 * episode (the sidecar emits `dream_cycle` started/ended pulses — see
 * `events.onDreamCycle`). The typing-bar mascot reads this to switch into its
 * `dreaming` pose so the user can see Cinderpaw is improving itself while idle.
 */
import { create } from 'zustand';

/** The BRSI §2.8 Dream Cycle stages the sidecar emits as `dream_cycle` pulses.
 *  `dream` / `mutate` are reserved (subsumed by the opaque engine episode in
 *  Faza 1), so only wake/observe/evaluate/remember/sleep fire today. */
export type DreamStage = 'wake' | 'observe' | 'dream' | 'mutate' | 'evaluate' | 'remember' | 'sleep';

interface DreamStore {
  dreaming: boolean;
  /** The current §2.8 stage while a cycle runs; null between cycles. */
  stage: DreamStage | null;
  setDreaming(v: boolean): void;
  setStage(s: DreamStage | null): void;
}

export const useDream = create<DreamStore>((set) => ({
  dreaming: false,
  stage: null,
  setDreaming: (v) => set({ dreaming: v }),
  setStage: (s) => set({ stage: s }),
}));
