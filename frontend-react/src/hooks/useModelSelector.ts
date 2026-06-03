import { useEffect, useState } from 'react';
import { tauri, events, type ModelInfo, type LoadedModel } from '@/lib/tauri';

interface ModelSelectorState {
  models: ModelInfo[];
  currentModel: LoadedModel | null;
  loading: boolean;
  loadingProgress: number;
  loadingStatus: string;
  error: string | null;
}

export function useModelSelector() {
  const [state, setState] = useState<ModelSelectorState>({
    models: [],
    currentModel: null,
    loading: false,
    loadingProgress: 0,
    loadingStatus: '',
    error: null,
  });

  // Load initial state: list of models + current loaded model
  useEffect(() => {
    const load = async () => {
      try {
        const [models, currentModel] = await Promise.all([
          tauri.models.list(),
          tauri.models.loaded(),
        ]);
        setState((prev) => ({
          ...prev,
          models,
          currentModel,
        }));
      } catch (e) {
        setState((prev) => ({
          ...prev,
          error: String(e),
        }));
      }
    };

    void load();
  }, []);

  // Listen for model load progress events
  useEffect(() => {
    let unlistener: (() => void) | null = null;

    const setupListener = async () => {
      unlistener = await events.modelLoadProgressEvent.listen((event) => {
        setState((prev) => ({
          ...prev,
          loadingProgress: event.payload.percentage,
          loadingStatus: event.payload.statusText,
        }));
      });
    };

    void setupListener();

    return () => {
      unlistener?.();
    };
  }, []);

  const selectModel = async (modelPath: string) => {
    setState((prev) => ({
      ...prev,
      loading: true,
      error: null,
      loadingProgress: 0,
      loadingStatus: 'Starting...',
    }));

    try {
      const loaded = await tauri.models.startLoad(modelPath);
      setState((prev) => ({
        ...prev,
        currentModel: loaded,
        loading: false,
        loadingProgress: 100,
        loadingStatus: 'Model Loaded!',
      }));

      // Clear success state after 2 seconds
      setTimeout(() => {
        setState((prev) => ({
          ...prev,
          loadingProgress: 0,
          loadingStatus: '',
        }));
      }, 2000);
    } catch (e) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: String(e),
      }));
    }
  };

  const unloadModel = async () => {
    try {
      await tauri.models.unload();
      setState((prev) => ({
        ...prev,
        currentModel: null,
        error: null,
      }));
    } catch (e) {
      setState((prev) => ({
        ...prev,
        error: String(e),
      }));
    }
  };

  return {
    ...state,
    selectModel,
    unloadModel,
  };
}
