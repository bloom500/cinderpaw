import { panelMotionEnd, panelMotionExit, panelMotionStart } from '@/lib/panelMotion';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, ArrowRight, Globe, Home, Loader2, Plus, RotateCw, Search, X } from 'lucide-react';
import { tauri } from '@/lib/tauri';
import { useBrowser } from '@/stores/browser';
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
export function BrowserPanel() {
  const { url, loading, error, notice, open, go, setPanel, tabs, active, newTab, switchTab, closeTab } = useBrowser();
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
      style={{ width }}
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
        // A native page on top of the panel would otherwise take the pointer
        // mid-drag; the page is parked while the edge is held.
        dragging && 'select-none',
      )}
    >
      <div
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
      />
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
        <ChromeButton label="Close browser" icon={X} onClick={close} />
      </form>
      {error && <p className="border-y border-border-subtle px-3 py-2 text-2xs text-(--warning)">{error}</p>}
      {notice && !error && <p className="border-y border-border-subtle px-3 py-2 text-2xs text-text-muted">{notice}</p>}
      <div ref={bodyRef} className="relative flex-1 bg-white">
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
    </motion.aside>
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
