import { create } from 'zustand';
import { listen } from '@tauri-apps/api/event';
import { tauri } from '@/lib/tauri';
import type {
  DownloadProgressEvent,
  DownloadCompleteEvent,
  DownloadErrorEvent,
} from '@/lib/tauri/events';

interface ActiveDownload {
  repoId: string;
  filename: string;
  progress: number;   // 0.0 – 1.0
  key: string;        // "repoId::filename"
}

interface DownloadStore {
  active: ActiveDownload | null;
  done: boolean;
  error: string | null;

  start:  (repoId: string, filename: string) => Promise<void>;
  cancel: () => Promise<void>;
  reset:  () => void;
}

export const useDownload = create<DownloadStore>((set, get) => ({
  active: null,
  done:   false,
  error:  null,

  start: async (repoId, filename) => {
    if (get().active !== null) throw new Error('A download is already in progress');
    const key = `${repoId}::${filename}`;
    set({ active: { repoId, filename, progress: 0, key }, done: false, error: null });
    // Fire-and-forget — completion comes via module-level event listeners
    try {
      await tauri.download.start(repoId, filename);
    } catch (err) {
      set({ active: null, error: String(err) });
    }
  },

  cancel: async () => {
    const { active } = get();
    if (!active) return;
    set({ active: null, done: false, error: null });
    try {
      await tauri.download.cancel(active.key);
    } catch { /* ignore — already cleared */ }
  },

  reset: () => set({ active: null, done: false, error: null }),
}));

// ── Module-level listeners — always-on, outlive any component ────────────────
// CRITICAL: these MUST be outside create() so they fire even when the
// component that called start() has unmounted (e.g. navigated away).
void listen<DownloadProgressEvent>('cinderpaw://download-progress', (e) => {
  const { active } = useDownload.getState();
  const key = `${e.payload.repoId}::${e.payload.filename}`;
  if (active?.key !== key) return;
  useDownload.setState({ active: { ...active, progress: e.payload.progress } });
});

// Every handler below checks the key first, the way the progress handler
// already did. Without it a LATE event from a download the user cancelled —
// the backend only learns about a cancel after the fact — cleared the state of
// the download they had just started instead: the new one vanished from the UI
// mid-transfer while it was still running underneath.
void listen<DownloadCompleteEvent>('cinderpaw://download-complete', (e) => {
  const { active } = useDownload.getState();
  if (active?.key !== `${e.payload.repoId}::${e.payload.filename}`) return;
  useDownload.setState({ active: null, done: true, error: null });
});

void listen<DownloadErrorEvent>('cinderpaw://download-error', (e) => {
  const { active } = useDownload.getState();
  if (active?.key !== `${e.payload.repoId}::${e.payload.filename}`) return;
  if (e.payload.cancelled) {
    useDownload.setState({ active: null, done: false, error: null });
  } else {
    useDownload.setState({ active: null, error: e.payload.error });
  }
});
