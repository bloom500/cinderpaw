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
  inferParams: { temperature: 0.8, top_p: 0.95, max_tokens: 2048 },

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
