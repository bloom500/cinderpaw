import { create } from 'zustand';
import { tauri, type Settings, type ByokProvider } from '@/lib/tauri';

export type { ByokProvider };

export interface ByokProviderUpdate {
  providerId: string;
  enabled: boolean;
  apiKey: string;
  baseUrl?: string | null;
  defaultModel?: string | null;
}

export interface ByokTestPayload {
  providerId: string;
  apiKey: string;
  baseUrl?: string | null;
}

export interface ByokTestResult { ok: boolean; error?: string }

interface SettingsStore {
  settings: Settings | null;
  byok: ByokProvider[];
  loading: boolean;
  saving: boolean;
  saved: boolean;

  fetchSettings: () => Promise<void>;
  fetchByok: () => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => void;
  /**
   * Toggle OS-level desktop control. Persists immediately and restarts the
   * sidecar (backend command) so the `control_app` tool (de)registers — this
   * is NOT batched into the manual Save button because the sidecar restart is
   * the whole point of the toggle. Optimistically updates local state and
   * rolls back on failure.
   */
  setDesktopControl: (enabled: boolean) => Promise<void>;
  /** Toggle YOLO/Safe mode for desktop control. Persists + restarts sidecar. */
  setDesktopControlYolo: (enabled: boolean) => Promise<void>;
  /** Set per-conversation token budget. null = unlimited; number = hard cap. Persists + restarts sidecar. */
  setTokenBudget: (budget: number | null) => Promise<void>;
  /** Set RSI background engine USD spend cap. null / 0 = local-only (free). */
  setRsiBudget: (budget: number | null) => Promise<void>;
  setRsiAllowCloudDreams: (enabled: boolean) => Promise<void>;
  /** MASTER dream-cycle switch. Persists + restarts sidecar (the gate is read at arm time). */
  setDreamsEnabled: (enabled: boolean) => Promise<void>;
  save: () => Promise<void>;
  saveByokProvider: (p: ByokProviderUpdate) => Promise<void>;
  removeByokProvider: (providerId: string) => Promise<void>;
  testByokProvider: (p: ByokTestPayload) => Promise<ByokTestResult>;
}

export const useSettings = create<SettingsStore>()((set, get) => ({
  settings: null,
  byok: [],
  loading: false,
  saving: false,
  saved: false,

  fetchSettings: async () => {
    set({ loading: true });
    try {
      const settings = await tauri.settings.get();
      set({ settings, loading: false });
    } catch (e) {
      console.error('fetchSettings failed', e);
      set({ loading: false });
    }
  },

  fetchByok: async () => {
    try {
      const byok = await tauri.raw.getByokSettings();
      set({ byok });
    } catch (e) {
      console.error('fetchByok failed', e);
    }
  },

  updateSettings: (patch) => {
    set((s) => s.settings ? { settings: { ...s.settings, ...patch } } : {});
  },

  setDesktopControl: async (enabled) => {
    const prev = get().settings;
    // Optimistic flip so the switch responds instantly.
    set((s) => s.settings ? { settings: { ...s.settings, desktop_control_enabled: enabled } } : {});
    try {
      await tauri.settings.setDesktopControl(enabled);
    } catch (e) {
      console.error('setDesktopControl failed', e);
      // Roll back to the previous value on failure.
      if (prev) set({ settings: { ...prev } });
      throw e;
    }
  },

  setDesktopControlYolo: async (enabled) => {
    const prev = get().settings;
    set((s) => s.settings ? { settings: { ...s.settings, desktop_control_yolo: enabled } } : {});
    try {
      await tauri.settings.setDesktopControlYolo(enabled);
    } catch (e) {
      console.error('setDesktopControlYolo failed', e);
      if (prev) set({ settings: { ...prev } });
      throw e;
    }
  },

  setTokenBudget: async (budget) => {
    const prev = get().settings;
    set((s) => s.settings ? { settings: { ...s.settings, token_budget_conversation: budget } } : {});
    try {
      await tauri.settings.setTokenBudget(budget);
    } catch (e) {
      console.error('setTokenBudget failed', e);
      if (prev) set({ settings: { ...prev } });
      throw e;
    }
  },

  setRsiBudget: async (budget) => {
    const prev = get().settings;
    set((s) => s.settings ? { settings: { ...s.settings, rsi_max_cost_usd: budget } } : {});
    try {
      await tauri.settings.setRsiBudget(budget);
    } catch (e) {
      console.error('setRsiBudget failed', e);
      if (prev) set({ settings: { ...prev } });
      throw e;
    }
  },

  setRsiAllowCloudDreams: async (enabled) => {
    const prev = get().settings;
    set((s) => s.settings ? { settings: { ...s.settings, rsi_allow_cloud_dreams: enabled } } : {});
    try {
      await tauri.settings.setRsiAllowCloudDreams(enabled);
    } catch (e) {
      console.error('setRsiAllowCloudDreams failed', e);
      if (prev) set({ settings: { ...prev } });
      throw e;
    }
  },

  setDreamsEnabled: async (enabled) => {
    const prev = get().settings;
    set((s) => s.settings ? { settings: { ...s.settings, dreams_enabled: enabled } } : {});
    try {
      await tauri.settings.setDreamsEnabled(enabled);
    } catch (e) {
      console.error('setDreamsEnabled failed', e);
      if (prev) set({ settings: { ...prev } });
      throw e;
    }
  },

  save: async () => {
    const { settings } = get();
    if (!settings) return;
    set({ saving: true });
    try {
      await tauri.settings.save(settings);
      set({ saving: false, saved: true });
      setTimeout(() => useSettings.setState({ saved: false }), 2000);
    } catch (e) {
      console.error('save failed', e);
      set({ saving: false });
    }
  },

  saveByokProvider: async (p) => {
    await tauri.raw.saveByokProvider(p.providerId, p.enabled, p.apiKey, p.baseUrl, p.defaultModel);
    await get().fetchByok();
  },

  removeByokProvider: async (providerId) => {
    await tauri.raw.removeByokProvider(providerId);
    await get().fetchByok();
  },

  testByokProvider: async (p) => {
    try {
      const raw = await tauri.raw.testByokProvider(p.providerId, p.apiKey, p.baseUrl) as { success: boolean; message: string };
      return { ok: raw.success, error: raw.success ? undefined : raw.message };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
}));
