import { create } from 'zustand';
import { tauri, events, type LoadedModel } from '@/lib/tauri';

type UnlistenFn = () => void;

interface ModelStore {
  loaded: LoadedModel | null;
  isLoading: boolean;
  loadProgress: { percentage: number; statusText: string } | null;

  refresh: () => Promise<void>;
  load:    (path: string) => Promise<void>;
  unload:  () => Promise<void>;
}

let progressUnlisten: UnlistenFn | null = null;

export const useModel = create<ModelStore>((set) => ({
  loaded: null,
  isLoading: false,
  loadProgress: null,

  refresh: async () => {
    const loaded = await tauri.models.loaded();
    set({ loaded });
  },

  load: async (path) => {
    set({ isLoading: true, loadProgress: { percentage: 0, statusText: 'Initializing...' } });
    if (progressUnlisten) { progressUnlisten(); progressUnlisten = null; }
    progressUnlisten = await events.modelLoadProgressEvent.listen((e) => {
      set({ loadProgress: { percentage: e.payload.percentage, statusText: e.payload.statusText } });
    });
    try {
      const loaded = await tauri.models.startLoad(path);
      set({ loaded, isLoading: false, loadProgress: null });
    } catch (err) {
      set({ isLoading: false, loadProgress: null });
      throw err;
    } finally {
      if (progressUnlisten) { progressUnlisten(); progressUnlisten = null; }
    }
  },

  unload: async () => {
    await tauri.models.unload();
    set({ loaded: null });
  },
}));
