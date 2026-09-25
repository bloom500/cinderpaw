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
export interface BrowserTab {
  id: number;
  title: string;
  url: string;
  loading: boolean;
  canBack: boolean;
  canForward: boolean;
  /** Requests the ad blocker answered on the page this tab shows now. */
  blocked: number;
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

/**
 * Schemes that name themselves without "//". Passed through so the host can
 * refuse the ones it does not open (javascript:, file:) instead of searching.
 */
const BARE_SCHEMES = /^(about|data|blob|file|mailto|tel|javascript|view-source):/i;

/**
 * An address as typed: a URL, a bare domain, or words for the search engine.
 *
 * Any "word:" at the start used to count as a scheme, so "localhost:3000"
 * went through raw and the host searched DuckDuckGo for it, and "Re: meeting"
 * was refused as a "re:" link. A local server is plain http, like every
 * browser assumes for it.
 */
export function toAddress(text: string, engine: string): string {
  const t = text.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || BARE_SCHEMES.test(t)) return t;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(t)) return `http://${t}`;
  if (/^[^\s]+\.[^\s]+$/.test(t)) return `https://${t}`;
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
  /** Modal dialogs open right now. Above zero, the panel parks the native page: a dialog cannot draw over it. */
  covered: number;
  cover: (delta: 1 | -1) => void;
  open: (address: string) => Promise<void>;
  go: (op: 'back' | 'forward' | 'reload' | 'home' | 'stop') => Promise<void>;
  newTab: () => Promise<void>;
  switchTab: (id: number) => Promise<void>;
  closeTab: (id: number) => Promise<void>;
  /** Addresses of tabs closed this session, last first, for Ctrl+Shift+T. */
  closed: string[];
  reopenTab: () => Promise<void>;
  /** What was downloaded this session, newest first: the list every browser has. */
  downloads: Array<{ name: string; at: number; dest?: string; artifact?: boolean; error?: string }>;
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

  covered: 0,
  cover: (delta) => set((s) => ({ covered: Math.max(0, s.covered + delta) })),
  setPanel: (open) => {
    set({ panelOpen: open });
    // The host restored last session's tabs at its first call, which may have
    // been the agent's, before this store existed to hear the state event: the
    // panel then opened on an empty tab row until "+" made the host speak
    // again (21 Sep). Ask, instead of waiting to be told.
    if (open) void tauri.browser.ui('state').then((r) => {
      const st = r as { active: number | null; tabs: BrowserTab[] };
      if (Array.isArray(st?.tabs)) set(fromState(st));
    }).catch(() => {});
  },

  open: async (address) => {
    const text = address.trim();
    if (!text) return;
    set({ error: null, notice: null, loading: true, panelOpen: true });
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
    const closing = get().tabs.find((t) => t.id === id);
    try {
      const st = await tauri.browser.ui('close_tab', { id });
      set({ ...fromState(st as never), error: null });
      // Every browser has undo-close; a tab shut by mistake is a common mistake.
      if (closing && closing.url !== HOME) set({ closed: [closing.url, ...get().closed].slice(0, 20) });
    } catch (e) {
      set({ error: String(e) });
    }
  },
  closed: [],
  downloads: [],
  reopenTab: async () => {
    const [last, ...rest] = get().closed;
    if (!last) return;
    set({ closed: rest });
    await get().newTab();
    await get().open(last);
  },
}));

// Module-level, like the download store: the host can report a page before the
// panel has ever been mounted. A failed listen (tests, a plain browser) is not
// an error worth surfacing.
/**
 * What the host says the tabs are now. Another page in front (a link
 * followed, a tab switched) clears what was said about the last one: nothing
 * else cleared the notice, so "No article on this page to read." sat under
 * the toolbar for the rest of the session, over every page.
 */
export function applyHostState(st: { active: number | null; tabs: BrowserTab[] }): void {
  const next = fromState(st);
  const now = useBrowser.getState();
  const moved = next.url !== now.url || next.active !== now.active;
  useBrowser.setState(moved ? { ...next, error: null, notice: null } : next);
}
void listen<{ active: number | null; tabs: BrowserTab[] }>('browser://state', (e) => applyHostState(e.payload)).catch(() => {});
// A download. A PDF or Word file goes to Artifacts, and `artifact: true`
// arrives once the agent has CONFIRMED it is there; anything else, and a
// document the agent refused (`reason`), is a file the person is asked where
// to put, with the reason on screen first.
void listen<{ name: string; started?: boolean; dest?: string; artifact?: boolean; error?: string; reason?: string | null }>('browser://download', (e) => {
  const { name, started, dest, artifact, error, reason } = e.payload;
  // The click that starts a download changes nothing on the page; without
  // this, a large file was minutes of nothing until it landed.
  if (started) { useBrowser.setState({ notice: `Downloading ${name}…` }); return; }
  const log = (entry: { dest?: string; artifact?: boolean; error?: string }) =>
    useBrowser.setState((st) => ({ downloads: [{ name, at: Date.now(), ...entry }, ...st.downloads].slice(0, 50) }));
  if (error) {
    useBrowser.setState({ notice: `Could not download ${name}: ${error}` });
    log({ error });
  } else if (artifact) {
    useBrowser.setState({ notice: `${name} is in Artifacts.` });
    log({ artifact: true });
  } else if (dest) {
    // Straight into the Downloads folder, like every browser; no dialog.
    useBrowser.setState({ notice: reason ? `${name}: ${reason}. Saved to Downloads.` : `Saved ${name} to Downloads.` });
    log({ dest });
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
