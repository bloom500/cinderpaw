import { create } from 'zustand';
import type { FeralModelConfigView, FeralModelSelection } from '@/lib/tauri';
import { tauri } from '@/lib/tauri';

interface FeralStore {
  /** Active model in the sidecar. Null until feral_get_model_config resolves. */
  modelConfig: FeralModelConfigView | null;
  /** True once feral://agent-ready fires. */
  isReady: boolean;
  /** Last set_model error, if any. Cleared on next setModel call. */
  modelError: string | null;
  /** Whether a setModel call is in flight. */
  switching: boolean;
  /**
   * #11: true after `feral://agent-exit` (sidecar crashed), false again when
   * `feral://agent-ready` fires post-restart. Drives the offline banner.
   */
  offline: boolean;
  /** True while the Rust supervisor is attempting an automatic restart. */
  restarting: boolean;

  setModelConfig(cfg: FeralModelConfigView): void;
  setReady(v: boolean): void;
  setModelError(err: string | null): void;
  setOffline(offline: boolean, restarting: boolean): void;

  /** Fetch and cache the current sidecar model config (display-safe, no key). */
  fetchModelConfig(): Promise<void>;

  /**
   * Hot-swap the Feral Agent model. Rust injects the API key from BYOK store —
   * the key never touches React. Throws on error so callers can surface it.
   */
  setModel(selection: FeralModelSelection): Promise<void>;
}

export const useFeralStore = create<FeralStore>((set) => ({
  modelConfig: null,
  isReady: false,
  modelError: null,
  switching: false,
  offline: false,
  restarting: false,

  setModelConfig(cfg) {
    set({ modelConfig: cfg, modelError: null });
  },

  setReady(v) {
    // Coming (back) online clears the offline banner.
    set(v ? { isReady: true, offline: false, restarting: false } : { isReady: false });
  },

  setOffline(offline, restarting) {
    set({ offline, restarting, ...(offline ? { isReady: false } : {}) });
  },

  setModelError(err) {
    set({ modelError: err });
  },

  async fetchModelConfig() {
    try {
      const cfg = await tauri.raw.feralGetModelConfig();
      if (cfg) set({ modelConfig: cfg });
    } catch {
      // Sidecar not yet ready — will retry when agent-ready fires.
    }
  },

  async setModel(selection) {
    set({ modelError: null, switching: true });
    try {
      if (selection.source === 'ollama') {
        await tauri.raw.feralSetModel('ollama', selection.model, null, selection.baseUrl);
      } else if (selection.source === 'byok') {
        await tauri.raw.feralSetModel('byok', selection.model, selection.providerId, null);
      } else {
        await tauri.raw.feralSetModel(
          'openai_compatible',
          selection.model,
          selection.providerId,
          selection.baseUrl,
        );
      }
      // Store is updated optimistically by Rust; model_set event from sidecar confirms.
      const cfg = await tauri.raw.feralGetModelConfig();
      if (cfg) set({ modelConfig: cfg });
    } catch (err) {
      set({ modelError: String(err) });
      throw err;
    } finally {
      set({ switching: false });
    }
  },
}));
