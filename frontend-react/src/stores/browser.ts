import { create } from 'zustand';
import { listen } from '@tauri-apps/api/event';
import { tauri } from '@/lib/tauri';

/**
 * The built-in browser panel: whether it is open, and what the page is doing.
 *
 * The page itself lives in the host (a child webview); this store only mirrors
 * it. The host reports every load through `browser://state`, and asks for the
 * panel through `browser://open` whenever the agent opens a page, so what the
 * agent does in the browser is always on screen.
 */
interface BrowserStore {
  panelOpen: boolean;
  url: string;
  loading: boolean;
  error: string | null;
  setPanel: (open: boolean) => void;
  open: (address: string) => Promise<void>;
  go: (op: 'back' | 'forward' | 'reload') => Promise<void>;
}

export const useBrowser = create<BrowserStore>((set) => ({
  panelOpen: false,
  url: '',
  loading: false,
  error: null,

  setPanel: (open) => set({ panelOpen: open }),

  open: async (address) => {
    const text = address.trim();
    if (!text) return;
    set({ error: null, loading: true, panelOpen: true });
    try {
      const res = await tauri.browser.ui('open', { url: text });
      set({ url: typeof res.url === 'string' ? res.url : text, loading: res.loading === true });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  go: async (op) => {
    try {
      await tauri.browser.ui(op);
    } catch (e) {
      set({ error: String(e) });
    }
  },
}));

// Module-level, like the download store: the host can report a page before the
// panel has ever been mounted. A failed listen (tests, a plain browser) is not
// an error worth surfacing.
void listen<{ url: string; loading: boolean }>('browser://state', (e) => {
  useBrowser.setState({ url: e.payload.url, loading: e.payload.loading });
}).catch(() => {});
void listen<{ url: string }>('browser://open', (e) => {
  useBrowser.setState({ panelOpen: true, url: e.payload.url, error: null });
}).catch(() => {});
