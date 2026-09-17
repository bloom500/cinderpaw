import { panelMotionEnd, panelMotionExit, panelMotionStart } from '@/lib/panelMotion';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, ArrowRight, Globe, Home, Loader2, Maximize2, MessageSquare, Minimize2, Plus, RotateCw, Search, Settings2, ShieldCheck, X } from 'lucide-react';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { tauri } from '@/lib/tauri';
import { SEARCH_ENGINES, useBrowser } from '@/stores/browser';
import { cn, readLocal, writeLocal } from '@/lib/utils';

const WIDTH_KEY = 'cinderpaw.browserPanelWidth';
const DEFAULT_WIDTH = 640;
const MIN_WIDTH = 360;
/** The chat column's own minimum (min-w-[28rem] in ChatPage). */
const CHAT_MIN_WIDTH = 448;

function clampWidth(w: number, rowWidth: number): number {
  const max = Math.max(MIN_WIDTH, rowWidth - CHAT_MIN_WIDTH);
  return Math.min(max, Math.max(MIN_WIDTH, Math.round(w)));
}

/** What a new tab offers: a search, and the places people go first. */
const SHORTCUTS: Array<{ label: string; url: string }> = [
  { label: 'DuckDuckGo', url: 'https://duckduckgo.com' },
  { label: 'Wikipedia', url: 'https://wikipedia.org' },
  { label: 'YouTube', url: 'https://youtube.com' },
  { label: 'Gmail', url: 'https://mail.google.com' },
  { label: 'GitHub', url: 'https://github.com' },
  { label: 'Reddit', url: 'https://reddit.com' },
];

/**
 * The built-in browser, beside the chat.
 *
 * This component draws the chrome (address bar, back, forward, reload) and an
 * empty body. The page is a native webview the host lays over that body, so the
 * body's rectangle is reported to the host whenever it moves, and the page is
 * parked off screen before the panel leaves (a native view does not follow a
 * React exit animation, and would float where the panel used to be).
 *
 * Anything React draws over the body area (a menu, a tooltip) sits BENEATH the
 * page: a native view is always on top. The panel keeps its own controls out of
 * that area for that reason.
 */
/**
 * `chat` is the conversation column, handed in by ChatPage. In wide mode the
 * browser takes the whole canvas up to the sidebar and the conversation opens
 * from a bubble, in a drawer beside the page. Beside, not over: the page is a
 * native view, and a native view is always on top of anything React draws, so
 * a chat floating over it would be hidden behind it.
 */
export function BrowserPanel({ chat }: { chat?: React.ReactNode }) {
  const {
    url, loading, error, notice, open, go, setPanel, tabs, active, newTab, switchTab, closeTab,
    wide, setWide, chatOpen, setChatOpen, engine, setEngine,
  } = useBrowser();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const current = tabs.find((t) => t.id === active);
  const [address, setAddress] = useState(url);
  const [editing, setEditing] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const [settled, setSettled] = useState(false);
  // Resizable from its left edge, the same way the Artifacts panel is. The
  // page follows through the ResizeObserver on the body.
  const rowWidth = () => asideRef.current?.parentElement?.clientWidth ?? window.innerWidth;
  const [width, setWidth] = useState(() => clampWidth(Number(readLocal(WIDTH_KEY)) || DEFAULT_WIDTH, window.innerWidth));
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; w: number } | null>(null);
  const [startQuery, setStartQuery] = useState('');
  // The slide in and out both run over the glass; see panelMotion. Started on
  // mount, ended when the enter animation completes (above); the exit is
  // marked for the length of the animation after unmount.
  const entered = useRef(false);
  useEffect(() => {
    panelMotionStart();
    return () => {
      if (!entered.current) panelMotionEnd();
      panelMotionExit();
    };
  }, []);

  // Follow the page's address unless the person is typing a new one.
  useEffect(() => {
    if (!editing) setAddress(url);
  }, [url, editing]);

  // Report where the page belongs, once the slide-in has finished and every
  // time the body changes size. One frame at a time: a resize fires in bursts.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || !settled) return;
    let frame = 0;
    const report = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        void tauri.browser
          .ui('set_bounds', { x: r.left, y: r.top, width: r.width, height: r.height, visible: true })
          .catch(() => {});
      });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    window.addEventListener('resize', report);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener('resize', report);
    };
  }, [settled]);

  // Leaving by any route (route change, unmount) parks the page.
  useEffect(() => () => void tauri.browser.ui('set_bounds', { visible: false }).catch(() => {}), []);

  const close = () => {
    void tauri.browser.ui('set_bounds', { visible: false }).catch(() => {});
    setPanel(false);
  };

  return (
    <motion.aside
      ref={asideRef}
      aria-label="Browser"
      initial={{ x: 32, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 32, opacity: 0 }}
      style={wide ? undefined : { width }}
      transition={dragging ? { duration: 0 } : { duration: 0.16, ease: 'easeOut' }}
      onAnimationComplete={() => {
        setSettled(true);
        if (!entered.current) {
          entered.current = true;
          panelMotionEnd();
        }
      }}
      className={cn(
        'relative flex min-w-[360px] shrink flex-col overflow-hidden border-l border-border-default bg-bg-surface',
        wide && 'w-full flex-1',
        // A native page on top of the panel would otherwise take the pointer
        // mid-drag; the page is parked while the edge is held.
        dragging && 'select-none',
      )}
    >
      {!wide && <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize browser panel"
        aria-valuenow={width}
        aria-valuemin={MIN_WIDTH}
        tabIndex={0}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, w: width };
          setDragging(true);
        }}
        onPointerMove={(e) => {
          if (drag.current) setWidth(clampWidth(drag.current.w + drag.current.x - e.clientX, rowWidth()));
        }}
        onPointerUp={() => {
          drag.current = null;
          setDragging(false);
          writeLocal(WIDTH_KEY, String(width));
        }}
        onKeyDown={(e) => {
          const step = e.key === 'ArrowLeft' ? 24 : e.key === 'ArrowRight' ? -24 : 0;
          if (!step) return;
          e.preventDefault();
          const next = clampWidth(width + step, rowWidth());
          setWidth(next);
          writeLocal(WIDTH_KEY, String(next));
        }}
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-brand/40 focus-visible:bg-brand/40 focus-visible:outline-hidden"
      />}
      {/* Tabs. pt-6 for the window's own buttons at the top-right, like the
          Artifacts panel. One row, scrolling sideways when there are many. */}
      <div role="tablist" aria-label="Tabs" className="flex items-end gap-1 overflow-x-auto px-2 pt-6 thin-scrollbar">
        {tabs.map((t) => (
          <div
            key={t.id}
            role="tab"
            aria-selected={t.id === active}
            tabIndex={0}
            onClick={() => void switchTab(t.id)}
            onKeyDown={(e) => { if (e.key === 'Enter') void switchTab(t.id); }}
            className={cn(
              'group flex max-w-[180px] shrink-0 cursor-default items-center gap-1 rounded-t-lg border border-b-0 px-2.5 py-1 text-2xs',
              t.id === active
                ? 'border-border-default bg-bg-elevated text-text-primary'
                : 'border-transparent text-text-muted hover:bg-bg-hover hover:text-text-secondary',
            )}
          >
            {t.loading && <Loader2 size={12} className="shrink-0 animate-spin" />}
            <span className="truncate">{t.url === 'about:blank' || !t.title ? 'New tab' : t.title}</span>
            <button
              type="button"
              aria-label={`Close tab ${t.title || 'New tab'}`}
              onClick={(e) => {
                e.stopPropagation();
                void closeTab(t.id);
              }}
              className="ml-1 rounded-sm p-0.5 opacity-0 hover:bg-bg-hover group-hover:opacity-100 focus-visible:opacity-100"
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <button
          type="button"
          aria-label="New tab"
          title="New tab"
          onClick={() => void newTab()}
          className="mb-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-bg-hover hover:text-text-primary"
        >
          <Plus size={14} />
        </button>
      </div>
      <form
        className="flex items-center gap-1 border-t border-border-default px-2 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          setEditing(false);
          void open(address);
        }}
      >
        <ChromeButton label="Back" icon={ArrowLeft} disabled={!current?.canBack} onClick={() => void go('back')} />
        <ChromeButton label="Forward" icon={ArrowRight} disabled={!current?.canForward} onClick={() => void go('forward')} />
        <ChromeButton label="Home" icon={Home} onClick={() => void go('home')} />
        <ChromeButton
          label="Reload"
          icon={loading ? Loader2 : RotateCw}
          spin={loading}
          onClick={() => void go('reload')}
        />
        <input
          aria-label="Address"
          value={address}
          placeholder="Search or type an address"
          spellCheck={false}
          onFocus={(e) => {
            setEditing(true);
            e.currentTarget.select();
          }}
          onBlur={() => setEditing(false)}
          onChange={(e) => setAddress(e.target.value)}
          className="h-8 min-w-0 flex-1 rounded-full border border-border-default bg-bg-elevated px-3 text-xs text-text-primary outline-hidden focus:border-brand"
        />
        <ChromeButton label="Browser settings" icon={Settings2} onClick={() => setSettingsOpen((v) => !v)} />
        <ChromeButton
          label={wide ? 'Back to split view' : 'Fill the window'}
          icon={wide ? Minimize2 : Maximize2}
          onClick={() => setWide(!wide)}
        />
        {wide && (
          // The bubble: the conversation, one press away while the page fills
          // the window. Brand-coloured so it reads as Cinderpaw, not as chrome.
          <button
            type="button"
            aria-label={chatOpen ? 'Hide chat' : 'Chat with Cinderpaw'}
            aria-pressed={chatOpen}
            title={chatOpen ? 'Hide chat' : 'Chat with Cinderpaw'}
            onClick={() => setChatOpen(!chatOpen)}
            className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-full bg-brand text-on-brand shadow-md hover:bg-brand/90',
              chatOpen && 'ring-2 ring-brand/40',
            )}
          >
            <MessageSquare size={16} />
          </button>
        )}
        <ChromeButton label="Close browser" icon={X} onClick={close} />
      </form>
      {settingsOpen && <BrowserSettings engine={engine} onEngine={setEngine} />}
      {error && <p className="border-y border-border-subtle px-3 py-2 text-2xs text-(--warning)">{error}</p>}
      {notice && !error && <p className="border-y border-border-subtle px-3 py-2 text-2xs text-text-muted">{notice}</p>}
      <div className="flex min-h-0 flex-1">
      <div ref={bodyRef} className="relative min-w-0 flex-1 bg-white">
        {!url && (
          // The new-tab page, until the first address: a search and the usual
          // first stops. After that the native page covers this area.
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-bg-surface px-8">
            <Globe size={28} className="text-text-muted" />
            <form
              className="flex w-full max-w-md items-center gap-2 rounded-full border border-border-default bg-bg-elevated px-4 py-2 focus-within:border-brand"
              onSubmit={(e) => {
                e.preventDefault();
                void open(startQuery);
              }}
            >
              <Search size={16} className="shrink-0 text-text-muted" />
              <input
                autoFocus
                aria-label="Search the web"
                value={startQuery}
                placeholder="Search DuckDuckGo or type an address"
                spellCheck={false}
                onChange={(e) => setStartQuery(e.target.value)}
                className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-hidden"
              />
            </form>
            <div className="flex flex-wrap justify-center gap-2">
              {SHORTCUTS.map((s) => (
                <button
                  key={s.url}
                  type="button"
                  onClick={() => void open(s.url)}
                  className="rounded-full border border-border-subtle px-3 py-1 text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                >
                  {s.label}
                </button>
              ))}
            </div>
            <p className="text-2xs text-text-muted">Cinderpaw can use this browser too; what it does shows here.</p>
          </div>
        )}
      </div>
      {wide && chatOpen && chat && (
        // Beside the page, at the chat column's own minimum width, so the
        // composer and the transcript are the ones the person already knows.
        <div className="flex w-[28rem] shrink-0 flex-col border-l border-border-default bg-bg-surface">
          {chat}
        </div>
      )}
      </div>
    </motion.aside>
  );
}

/**
 * The browser's own settings: which engine answers the bar, and the ad
 * blocker. The blocker is uBlock Origin Lite, fetched from its GitHub release
 * on the person's press (GPLv3; not bundled with an Apache-2.0 app) into the
 * extensions folder WebView2 loads. Extensions are Windows only, and a new one
 * is picked up when Cinderpaw next starts, because the browser environment is
 * created once with the first tab.
 */
function BrowserSettings({ engine, onEngine }: { engine: string; onEngine: (e: string) => void }) {
  const [ext, setExt] = useState<{ path: string; extensions: Array<{ name: string; version: string }> } | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const refresh = () => {
    void tauri.browser.ui('extensions').then((r) => setExt(r as never)).catch(() => setExt(null));
  };
  useEffect(refresh, []);
  const hasBlocker = ext?.extensions.some((e) => /ublock/i.test(e.name)) ?? false;
  const isWindows = navigator.userAgent.includes('Windows');

  return (
    <div className="flex flex-col gap-3 border-b border-border-subtle bg-bg-elevated/40 px-3 py-3 text-xs">
      <label className="flex items-center gap-2">
        <span className="w-28 shrink-0 text-text-muted">Search with</span>
        <select
          aria-label="Search engine"
          value={engine}
          onChange={(e) => onEngine(e.target.value)}
          className="rounded-md border border-border-default bg-bg-surface px-2 py-1 text-xs text-text-primary"
        >
          {Object.entries(SEARCH_ENGINES).map(([id, e]) => <option key={id} value={id}>{e.label}</option>)}
        </select>
      </label>
      <div className="flex items-center gap-2">
        <span className="w-28 shrink-0 text-text-muted">Ad blocker</span>
        {!isWindows ? (
          <span className="text-text-muted">Browser extensions are not available on this system yet.</span>
        ) : hasBlocker ? (
          <span className="flex items-center gap-1 text-text-secondary"><ShieldCheck size={14} /> uBlock Origin Lite installed</span>
        ) : (
          <button
            type="button"
            disabled={installing === 'busy'}
            onClick={() => {
              setInstalling('busy');
              tauri.browser.ui('install_adblock')
                .then(() => { setInstalling('Installed. It starts blocking when Cinderpaw next opens.'); refresh(); })
                .catch((e) => setInstalling(`Could not install: ${String(e)}`));
            }}
            className="rounded-md border border-border-default px-2 py-1 text-xs text-text-primary hover:bg-bg-hover disabled:opacity-60"
          >
            {installing === 'busy' ? 'Downloading…' : 'Install uBlock Origin Lite'}
          </button>
        )}
      </div>
      {installing && installing !== 'busy' && <p className="text-2xs text-text-muted">{installing}</p>}
      {ext && ext.extensions.length > 0 && (
        <p className="text-2xs text-text-muted">
          {`Extensions: ${ext.extensions.map((e) => `${e.name} ${e.version}`).join(', ')}.`}
        </p>
      )}
      {ext && isWindows && (
        <button
          type="button"
          onClick={() => void shellOpen(ext.path)}
          className="self-start text-2xs text-text-muted underline-offset-2 hover:underline"
        >
          Open the extensions folder (drop an unpacked Chrome extension there)
        </button>
      )}
    </div>
  );
}

function ChromeButton({
  label, icon: Icon, onClick, spin, disabled,
}: {
  label: string;
  icon: typeof Globe;
  onClick: () => void;
  spin?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-8 shrink-0 items-center justify-center rounded-full text-text-muted hover:bg-bg-hover hover:text-text-primary disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <Icon size={16} className={cn(spin && 'animate-spin')} />
    </button>
  );
}
