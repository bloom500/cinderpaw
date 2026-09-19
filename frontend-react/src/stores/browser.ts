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

/** Where words typed into the bar go. DuckDuckGo by default: no account, no profile. */
export const SEARCH_ENGINES: Record<string, { label: string; url: string }> = {
  duckduckgo: { label: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  brave: { label: 'Brave Search', url: 'https://search.brave.com/search?q=' },
  startpage: { label: 'Startpage', url: 'https://www.startpage.com/do/search?q=' },
  google: { label: 'Google', url: 'https://www.google.com/search?q=' },
  bing: { label: 'Bing', url: 'https://www.bing.com/search?q=' },
};
const ENGINE_KEY = 'cinderpaw.browserSearchEngine';

/** An address as typed: a URL, a bare domain, or words for the search engine. */
export function toAddress(text: string, engine: string): string {
  const t = text.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return t;
  if (/^[^\s]+\.[^\s]+$/.test(t) || /^localhost(:\d+)?(\/|$)/.test(t)) return `https://${t.replace(/^https?:\/\//, '')}`;
  return `${(SEARCH_ENGINES[engine] ?? SEARCH_ENGINES.duckduckgo!).url}${encodeURIComponent(t)}`;
}

interface BrowserStore {
  panelOpen: boolean;
  /**
   * A voice call is showing the page in its own frame. The panel behind the
   * call must not place the page too: two places reporting bounds is a page
   * that jumps between them.
   */
  inCall: boolean;
  /** The browser takes the whole canvas up to the sidebar; the chat folds into a bubble. */
  wide: boolean;
  /** In wide mode: the chat drawer beside the page is open. */
  chatOpen: boolean;
  setWide: (wide: boolean) => void;
  setChatOpen: (open: boolean) => void;
  engine: string;
  setEngine: (engine: string) => void;
  tabs: BrowserTab[];
  active: number | null;
  /** The active tab's address, '' on the start page. */
  url: string;
  loading: boolean;
  error: string | null;
  /** What happened to the last download, in a sentence. */
  notice: string | null;
  /** What the agent is doing in the browser right now, or null. */
  agent: { op: string; url?: string; ref?: string; busy: boolean } | null;
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

export const useBrowser = create<BrowserStore>((set, get) => ({
  panelOpen: false,
  inCall: false,
  wide: false,
  chatOpen: false,
  setWide: (wide) => set({ wide }),
  setChatOpen: (chatOpen) => set({ chatOpen }),
  engine: (() => { try { return localStorage.getItem(ENGINE_KEY) ?? 'duckduckgo'; } catch { return 'duckduckgo'; } })(),
  setEngine: (engine) => {
    try { localStorage.setItem(ENGINE_KEY, engine); } catch { /* per-viewer convenience only */ }
    set({ engine });
  },
  tabs: [],
  active: null,
  url: '',
  loading: false,
  error: null,
  notice: null,
  agent: null,

  setPanel: (open) => set({ panelOpen: open }),

  open: async (address) => {
    const text = address.trim();
    if (!text) return;
    set({ error: null, loading: true, panelOpen: true });
    try {
      const res = await tauri.browser.ui('open', { url: toAddress(text, get().engine) });
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
// A download. A PDF or Word file goes to Artifacts, and `artifact: true`
// arrives once the agent has CONFIRMED it is there; anything else, and a
// document the agent refused (`reason`), is a file the person is asked where
// to put, with the reason on screen first.
void listen<{ name: string; path?: string; artifact?: boolean; error?: string; reason?: string }>('browser://download', async (e) => {
  const { name, path, artifact, error, reason } = e.payload;
  if (error) {
    useBrowser.setState({ notice: `Could not download ${name}: ${error}` });
    return;
  }
  if (artifact) {
    useBrowser.setState({ notice: `${name} is in Artifacts.` });
    return;
  }
  if (!path) return;
  if (reason) useBrowser.setState({ notice: `${name}: ${reason}. Choose where to save it.` });
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
// The agent at work: shown while its action runs and for a moment after, so a
// click by Cinderpaw never looks like the page acting on its own.
let agentTimer: ReturnType<typeof setTimeout> | null = null;
void listen<{ op: string; url?: string; ref?: string; busy: boolean }>('browser://agent', (e) => {
  if (agentTimer) clearTimeout(agentTimer);
  useBrowser.setState({ agent: e.payload });
  if (!e.payload.busy) agentTimer = setTimeout(() => useBrowser.setState({ agent: null }), 2500);
}).catch(() => {});
void listen<{ url: string }>('browser://open', (e) => {
  useBrowser.setState({ panelOpen: true, url: e.payload.url, error: null });
}).catch(() => {});
