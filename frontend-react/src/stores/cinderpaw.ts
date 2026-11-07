import { create } from 'zustand';
import type { CinderpawModelConfigView, CinderpawModelSelection } from '@/lib/tauri';
import { tauri } from '@/lib/tauri';
import { isChatgptRoute, isLocalEngineUrl } from '@/lib/localApi';

interface CinderpawStore {
  /** Active model in the sidecar. Null until cinderpaw_get_model_config resolves. */
  modelConfig: CinderpawModelConfigView | null;
  /** True once cinderpaw://agent-ready fires. */
  isReady: boolean;
  /** Last set_model error, if any. Cleared on next setModel call. */
  modelError: string | null;
  /** Whether a setModel call is in flight. */
  switching: boolean;
  /**
   * #11: true after `cinderpaw://agent-exit` (sidecar crashed), false again when
   * `cinderpaw://agent-ready` fires post-restart. Drives the offline banner.
   */
  offline: boolean;
  /** True while the Rust supervisor is attempting an automatic restart. */
  restarting: boolean;
  /**
   * Why Agent mode stopped, in the words Rust used. Only set when the
   * supervisor gave up (`restarting: false`), because that is the only case
   * where the person has to do something. Null the rest of the time.
   */
  offlineReason: string | null;

  setModelConfig(cfg: CinderpawModelConfigView): void;
  setReady(v: boolean): void;
  setModelError(err: string | null): void;
  setOffline(offline: boolean, restarting: boolean, reason?: string | null): void;

  /** Fetch and cache the current sidecar model config (display-safe, no key). */
  fetchModelConfig(): Promise<void>;

  /**
   * Hot-swap the Cinderpaw Agent model. Rust injects the API key from BYOK store —
   * the key never touches React. Throws on error so callers can surface it.
   */
  setModel(selection: CinderpawModelSelection): Promise<void>;

  /**
   * Automatic ("Let Cinderpaw choose" in the model menu): the brain answers each
   * message from any of the person's models. On by default, the iOS way; a
   * model picked by hand turns it off. Kept in this window's storage.
   */
  automatic: boolean;
  /** `apply: false` only records it, for a hand pick that switches the model itself next. */
  setAutomatic(on: boolean, apply?: boolean): Promise<void>;
}

const AUTO_KEY = 'cinderpaw.automaticModel';
function readAutomatic(): boolean {
  try { return localStorage.getItem(AUTO_KEY) !== 'off'; } catch { return true; }
}

/** The selection that points the engine back at the model it is on now. */
export function selectionOf(cfg: CinderpawModelConfigView): CinderpawModelSelection {
  if (cfg.provider === 'ollama') return { source: 'ollama', model: cfg.model, baseUrl: cfg.base_url };
  if (cfg.provider === 'cinderpaw-local' || isLocalEngineUrl(cfg.base_url)) {
    // The ChatGPT plan answers through this host's API too, but it is a provider.
    if (!isChatgptRoute(cfg.base_url)) return { source: 'openai_compatible', model: cfg.model, baseUrl: cfg.base_url, providerId: 'cinderpaw-local' };
  }
  return { source: 'byok', providerId: cfg.provider, model: cfg.model };
}

// Sent once per engine start: the engine boots on one model and learns the
// rest from set_model. Reset when it goes offline, so a restart sends it again.
let automaticSent = false;

/** The model in use answers from the internet (a key), not from this machine. */
export const onCloudModel = (s: Pick<CinderpawStore, 'modelConfig'>): boolean =>
  !!s.modelConfig?.base_url &&
  (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(s.modelConfig.base_url) || isChatgptRoute(s.modelConfig.base_url));

export const useCinderpawStore = create<CinderpawStore>((set, get) => ({
  modelConfig: null,
  isReady: false,
  modelError: null,
  switching: false,
  offline: false,
  restarting: false,
  offlineReason: null,
  automatic: readAutomatic(),

  async setAutomatic(on, apply = true) {
    try { localStorage.setItem(AUTO_KEY, on ? 'on' : 'off'); } catch { /* the default comes back next launch */ }
    set({ automatic: on });
    if (!apply) return;
    const cfg = get().modelConfig ?? (await tauri.raw.cinderpawGetModelConfig().catch(() => null));
    if (cfg?.model) await get().setModel(selectionOf(cfg));
  },

  setModelConfig(cfg) {
    set({ modelConfig: cfg, modelError: null });
  },

  setReady(v) {
    // Coming (back) online clears the offline banner.
    set(v ? { isReady: true, offline: false, restarting: false, offlineReason: null } : { isReady: false });
    // The engine boots on one model; Automatic's list reaches it only through
    // set_model, so it goes out once per start (the person never has to re-pick).
    if (v && get().automatic && !automaticSent) {
      automaticSent = true;
      void tauri.raw.cinderpawGetModelConfig()
        .then((cfg) => (cfg?.model ? get().setModel(selectionOf(cfg)) : undefined))
        .catch(() => { automaticSent = false; });
    }
  },

  setOffline(offline, restarting, reason = null) {
    if (offline) automaticSent = false;
    set({ offline, restarting, offlineReason: reason, ...(offline ? { isReady: false } : {}) });
  },

  setModelError(err) {
    set({ modelError: err });
  },

  async fetchModelConfig() {
    try {
      const cfg = await tauri.raw.cinderpawGetModelConfig();
      if (cfg) set({ modelConfig: cfg });
    } catch {
      // Sidecar not yet ready — will retry when agent-ready fires.
    }
  },

  async setModel(selection) {
    set({ modelError: null, switching: true });
    try {
      const auto = get().automatic;
      if (selection.source === 'ollama') {
        await tauri.raw.cinderpawSetModel('ollama', selection.model, null, selection.baseUrl, auto);
      } else if (selection.source === 'byok') {
        await tauri.raw.cinderpawSetModel('byok', selection.model, selection.providerId, null, auto);
      } else {
        await tauri.raw.cinderpawSetModel(
          'openai_compatible',
          selection.model,
          selection.providerId,
          selection.baseUrl,
          auto,
        );
      }
      automaticSent = auto;
      // Store is updated optimistically by Rust; model_set event from sidecar confirms.
      const cfg = await tauri.raw.cinderpawGetModelConfig();
      if (cfg) set({ modelConfig: cfg });
    } catch (err) {
      set({ modelError: String(err) });
      throw err;
    } finally {
      set({ switching: false });
    }
  },
}));
