/**
 * Dream Cycle UI state.
 *
 * `dreaming` is true while the RSI evolutionary engine runs a background
 * episode (the sidecar emits `dream_cycle` started/ended pulses — see
 * `events.onDreamCycle`). The typing-bar mascot reads this to switch into its
 * `dreaming` pose so the user can see Feral is improving itself while idle.
 */
import { create } from 'zustand';

interface DreamStore {
  dreaming: boolean;
  setDreaming(v: boolean): void;
}

export const useDream = create<DreamStore>((set) => ({
  dreaming: false,
  setDreaming: (v) => set({ dreaming: v }),
}));
