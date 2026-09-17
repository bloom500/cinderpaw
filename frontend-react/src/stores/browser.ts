import { create } from 'zustand';
import { listen } from '@tauri-apps/api/event';
import { tauri } from '@/lib/tauri';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';

/**
 * The built-in browser panel: whether it is open, and what the page is doing.
 *
 * The page itself lives in the host (a child webview); this store only mirrors
 * it. The host reports every load through `browser://state`, and asks for the
 * panel through `browser://open` whenever the agent opens a page, so what the
 * agent does in the browser is always on screen.
 */
export interface BrowserTab {
  id: number;
  title: string;
  url: string;
  loading: boolean;
  canBack: boolean;
  canForward: boolean;
}

/** The start page: the host parks the tab's page and the panel shows its own. */
export const HOME = 'about:blank';

interface BrowserStore {
  panelOpen: boolean;
  tabs: BrowserTab[];
  active: number | null;
  /** The active tab's address, '' on the start page. */
  url: string;
  loading: boolean;
  error: string | null;
  /** What happened to the last download, in a sentence. */
  notice: string | null;
  setPanel: (open: boolean) => void;
  open: (address: string) => Promise<void>;
  go: (op: 'back' | 'forward' | 'reload' | 'home') => Promise<void>;
  newTab: () => Promise<void>;
  switchTab: (id: number) => Promise<void>;
  closeTab: (id: number) => Promise<void>;
}

function fromState(st: { active: number | null; tabs: BrowserTab[] }) {
  const tab = st.tabs.find((t) => t.id === st.active) ?? null;
  return {
    tabs: st.tabs,
    active: st.active,
    url: tab && tab.url !== HOME ? tab.url : '',
    loading: tab?.loading ?? false,
  };
}

export const useBrowser = create<BrowserStore>((set) => ({
  panelOpen: false,
  tabs: [],
  active: null,
  url: '',
  loading: false,
  error: null,
  notice: null,

  setPanel: (open) => set({ panelOpen: open }),

  open: async (address) => {
    const text = address.trim();
    if (!text) return;
    set({ error: null, loading: true, panelOpen: true });
    try {
      const res = await tauri.browser.ui('open', { url: text });
      const url = typeof res.url === 'string' ? res.url : text;
      set({ url: url === HOME ? '' : url, loading: res.loading === true });
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

  newTab: async () => {
    try {
      const st = await tauri.browser.ui('new_tab');
      set({ ...fromState(st as never), error: null });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  switchTab: async (id) => {
    try {
      const st = await tauri.browser.ui('switch_tab', { id });
      set({ ...fromState(st as never), error: null });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  closeTab: async (id) => {
    try {
      const st = await tauri.browser.ui('close_tab', { id });
      set({ ...fromState(st as never), error: null });
    } catch (e) {
      set({ error: String(e) });
    }
  },
}));

// Module-level, like the download store: the host can report a page before the
// panel has ever been mounted. A failed listen (tests, a plain browser) is not
// an error worth surfacing.
void listen<{ active: number | null; tabs: BrowserTab[] }>('browser://state', (e) => {
  useBrowser.setState(fromState(e.payload));
}).catch(() => {});
// A download. A PDF or Word file has already gone to Artifacts by the time
// this arrives; anything else is a file the person is asked where to put.
void listen<{ name: string; path?: string; artifact?: boolean; error?: string }>('browser://download', async (e) => {
  const { name, path, artifact, error } = e.payload;
  if (error) {
    useBrowser.setState({ notice: `Could not download ${name}: ${error}` });
    return;
  }
  if (artifact) {
    useBrowser.setState({ notice: `${name} is in Artifacts.` });
    return;
  }
  if (!path) return;
  try {
    const dest = await saveDialog({ defaultPath: name });
    if (dest) {
      const res = await tauri.browser.ui('save_download', { path, dest });
      useBrowser.setState({ notice: `Saved ${name} to ${String(res.path ?? dest)}` });
    } else {
      await tauri.browser.ui('discard_download', { path });
      useBrowser.setState({ notice: null });
    }
  } catch (err) {
    useBrowser.setState({ notice: `Could not save ${name}: ${String(err)}` });
  }
}).catch(() => {});
void listen<{ url: string }>('browser://open', (e) => {
  useBrowser.setState({ panelOpen: true, url: e.payload.url, error: null });
}).catch(() => {});
