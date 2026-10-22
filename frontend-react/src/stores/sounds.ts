import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface SoundSettings {
  enabled: boolean;
  volume: number;
  setEnabled: (enabled: boolean) => void;
  setVolume: (volume: number) => void;
}

export const useSoundSettings = create<SoundSettings>()(persist((set) => ({
  enabled: true,
  volume: 0.35,
  setEnabled: (enabled) => set({ enabled }),
  setVolume: (volume) => set({ volume: Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0 }),
}), {
  name: 'cinderpaw-sounds',
  partialize: ({ enabled, volume }) => ({ enabled, volume }),
}));
