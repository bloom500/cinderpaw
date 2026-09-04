import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { tauri, events, type LoadedModel } from '@/lib/tauri';
import { useNotifications } from '@/stores/notifications';

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

/**
 * Tell the user once, at load time, when their GPU was available but ended up
 * unused — the model fell back to CPU (VRAM too small, or the driver refused
 * the allocation). Until now this only existed as a line in a log file, so the
 * symptom the user actually got was "Cinderpaw is slow" with no cause attached.
 *
 * Only the bad case is announced. A successful GPU load is visible in the
 * badge and does not deserve an interruption.
 */
function notifyIfGpuUnused(loaded: LoadedModel) {
  if (!loaded.backend?.includes('GPU build')) return;
  useNotifications.getState().push(
    'info',
    'Running on CPU, your GPU is not being used',
    `${loaded.name} did not fit in VRAM, so every layer runs on the CPU and replies will be slow. ` +
      'A smaller model, or a shorter context window in Settings → Hardware, will fit on the card.',
  );
}

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
    try {
      // Inside the try. `listen()` is async and can reject — the host not ready
      // yet at first paint, a permission refused — and it used to sit ABOVE the
      // try with `isLoading: true` already set. The rejection escaped past every
      // reset, so the spinner turned forever and the Load button stayed disabled
      // until the user reloaded the window, with nothing on screen suggesting
      // that would help.
      progressUnlisten = await events.modelLoadProgressEvent.listen((e) => {
        set({ loadProgress: { percentage: e.payload.percentage, statusText: e.payload.statusText } });
      });
      const maxContext = useModel.getState().contextByModel[path];
      const loaded = await tauri.models.startLoad(path, maxContext);
      set({ loaded, isLoading: false, loadProgress: null });
      notifyIfGpuUnused(loaded);
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
  name: 'cinderpaw-model',
  partialize: (s) => ({ cloudModel: s.cloudModel, inferParams: s.inferParams, contextByModel: s.contextByModel }),
}));

