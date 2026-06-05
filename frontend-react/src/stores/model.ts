import { create } from 'zustand';
import { tauri, events, type LoadedModel } from '@/lib/tauri';

type UnlistenFn = () => void;

export interface CloudModel {
  providerId: string;
  providerName: string;
  modelId: string;
}

export interface InferParamsUI {
  temperature: number;
  top_p: number;
  max_tokens: number;
}

interface ModelStore {
  loaded: LoadedModel | null;
  isLoading: boolean;
  loadProgress: { percentage: number; statusText: string } | null;
  cloudModel: CloudModel | null;
  inferParams: InferParamsUI;

  refresh: () => Promise<void>;
  load:    (path: string) => Promise<void>;
  unload:  () => Promise<void>;
  setCloudModel: (m: CloudModel | null) => void;
  setInferParams: (patch: Partial<InferParamsUI>) => void;
}

let progressUnlisten: UnlistenFn | null = null;

export const useModel = create<ModelStore>((set) => ({
  loaded: null,
  isLoading: false,
  loadProgress: null,
  cloudModel: null,
  // Default max_tokens bumped to 4096 — Gemma and other openai_compatible
  // providers can hit the 2048 cap mid-list and leave responses cut off
  // mid-word. 4096 gives comfortable headroom for most chat replies.
  inferParams: { temperature: 0.8, top_p: 0.95, max_tokens: 4096 },

  refresh: async () => {
    const loaded = await tauri.models.loaded();
    set({ loaded });
  },

  load: async (path) => {
    set({ isLoading: true, cloudModel: null, loadProgress: { percentage: 0, statusText: 'Initializing...' } });
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

  setCloudModel: (cloudModel) => set({ cloudModel }),
  setInferParams: (patch) => set((s) => ({ inferParams: { ...s.inferParams, ...patch } })),
}));
