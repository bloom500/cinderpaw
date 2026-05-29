import { create } from 'zustand';
import { tauri, type SystemInfo } from '@/lib/tauri';

interface SystemInfoStore {
  info: SystemInfo | null;
  loading: boolean;
  fetch: () => Promise<void>;
}

export const useSystemInfo = create<SystemInfoStore>((set, get) => ({
  info:    null,
  loading: false,

  fetch: async () => {
    if (get().loading || get().info) return;   // fetch once only
    set({ loading: true });
    try {
      const info = await tauri.system.info();
      set({ info, loading: false });
    } catch {
      set({ loading: false });   // degrade gracefully — system bar just stays hidden
    }
  },
}));
