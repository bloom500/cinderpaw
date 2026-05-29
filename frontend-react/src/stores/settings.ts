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
  save: () => Promise<void>;
  saveByokProvider: (p: ByokProviderUpdate) => Promise<void>;
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

  testByokProvider: async (p) => {
    try {
      const raw = await tauri.raw.testByokProvider(p.providerId, p.apiKey, p.baseUrl) as { success: boolean; message: string };
      return { ok: raw.success, error: raw.success ? undefined : raw.message };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
}));
