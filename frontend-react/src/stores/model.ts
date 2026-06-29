import { create } from 'zustand';
import { persist } from 'zustand/middleware';
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
  /** User-chosen context window (tokens) per local model PATH. Absent → load
   *  with the conservative backend default (opt-in: see Hardware settings). */
  contextByModel: Record<string, number>;

  refresh: () => Promise<void>;
  load:    (path: string) => Promise<void>;
  unload:  () => Promise<void>;
  setCloudModel: (m: CloudModel | null) => void;
  setInferParams: (patch: Partial<InferParamsUI>) => void;
  /** Persist a context-window choice for a model and reload it at that size
   *  (the KV cache is allocated at load time, so changing it needs a reload). */
  setModelContext: (path: string, tokens: number) => Promise<void>;
}

let progressUnlisten: UnlistenFn | null = null;

// Persisted: cloudModel + inferParams survive app restarts, so a returning
// user lands straight back on their chosen cloud model instead of an empty
// state. `loaded` (the local llama.cpp model) is process state and cannot be
// persisted — restoring it needs an actual load, handled separately.
export const useModel = create<ModelStore>()(persist((set) => ({
  loaded: null,
  isLoading: false,
  loadProgress: null,
  cloudModel: null,
  // Default max_tokens bumped to 4096 — Gemma and other openai_compatible
  // providers can hit the 2048 cap mid-list and leave responses cut off
  // mid-word. 4096 gives comfortable headroom for most chat replies.
  inferParams: { temperature: 0.8, top_p: 0.95, max_tokens: 4096 },
  contextByModel: {},

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
      const maxContext = useModel.getState().contextByModel[path];
      const loaded = await tauri.models.startLoad(path, maxContext);
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

  setModelContext: async (path, tokens) => {
    set((s) => ({ contextByModel: { ...s.contextByModel, [path]: tokens } }));
    // Reload at the new size (KV cache is sized at load). The ChatPage effect
    // re-points the sidecar on `loaded` change, forwarding the new window.
    await useModel.getState().load(path);
  },
}), {
  name: 'feral-model',
  partialize: (s) => ({ cloudModel: s.cloudModel, inferParams: s.inferParams, contextByModel: s.contextByModel }),
}));

