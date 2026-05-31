import { create } from 'zustand';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'up-to-date'
  | 'error';

export interface UpdateInfo {
  version: string;
  notes: string | null;
}

interface UpdaterStore {
  status: UpdateStatus;
  info: UpdateInfo | null;
  progress: number;
  error: string | null;
  /** Pending Update handle from the plugin, kept between check() and install(). */
  _update: Awaited<ReturnType<typeof check>> | null;

  /** Query the endpoint. Sets `available` (with info) or `up-to-date` / `error`. Never auto-installs. */
  check: () => Promise<void>;
  /** Download + install the pending update, then relaunch. */
  install: () => Promise<void>;
  /** Hide the toast / reset to idle (the "Later" action). */
  dismiss: () => void;
}

export const useUpdater = create<UpdaterStore>((set, get) => ({
  status: 'idle',
  info: null,
  progress: 0,
  error: null,
  _update: null,

  check: async () => {
    set({ status: 'checking', error: null, info: null, _update: null });
    try {
      const update = await check();
      if (!update) {
        set({ status: 'up-to-date' });
        return;
      }
      set({
        status: 'available',
        info: { version: update.version, notes: update.body ?? null },
        _update: update,
      });
    } catch (e) {
      set({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  },

  install: async () => {
    const update = get()._update;
    if (!update) return;

    set({ status: 'downloading', progress: 0, error: null });
    try {
      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? 0;
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
          set({ progress: total > 0 ? Math.round((downloaded / total) * 100) : 0 });
        } else if (event.event === 'Finished') {
          set({ progress: 100 });
        }
      });
      await relaunch();
    } catch (e) {
      set({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  },

  dismiss: () => set({ status: 'idle' }),
}));
