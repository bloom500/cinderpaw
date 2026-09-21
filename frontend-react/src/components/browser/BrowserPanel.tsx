import { onPanelMotionSettled, panelMotionEnd, panelMotionExit, panelMotionStart } from '@/lib/panelMotion';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, ArrowRight, BookOpen, ChevronDown, ChevronUp, Download, Globe, Star, Home, Loader2, Maximize2, MessageSquare, Minimize2, Plus, RotateCw, Search, Settings2, ShieldCheck, X } from 'lucide-react';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { tauri } from '@/lib/tauri';
import { SEARCH_ENGINES, useBrowser } from '@/stores/browser';
import { ENGINE_LOGOS } from '@/lib/engineLogos';
import { cn, readLocal, writeLocal, SECONDARY_BUTTON } from '@/lib/utils';
import { listen } from '@tauri-apps/api/event';
import { SelectMenu } from '@/components/ui/select-menu';
import { loadHistory, saveHistory, recordVisit, recordTitle, recordPick, loadBookmarks, saveBookmarks, upsertBookmark, removeBookmark, parseTags, findBookmarks, display, isReaderUrl, readerOriginal } from '@/lib/browserHistory';
import { AddressSuggestions, useAddressSuggestions } from './AddressSuggestions';

const WIDTH_KEY = 'cinderpaw.browserPanelWidth';
const ZOOM_KEY = 'cinderpaw.browserZoom';
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
    url: rawUrl, loading, error, notice, open, go, setPanel, tabs, active, newTab, switchTab, closeTab, reopenTab,
    wide, setWide, chatOpen, setChatOpen, engine, setEngine, agent, inCall, covered,
  } = useBrowser();
  // Reader view is a page of our own; the chrome keeps showing the article's
  // original address (bookmarks, history and the star all take that one).
  const readerOn = isReaderUrl(rawUrl);
  const url = readerOn ? readerOriginal(rawUrl) : rawUrl;
  const addressRef = useRef<HTMLInputElement>(null);
  // The key handler is registered once; this always points at the latest zoom.
  const zoomRef = useRef<((f: number) => void) & { level: number }>(Object.assign(() => {}, { level: 1 }));
  // Find in page: the query lives here, the matching happens in the page
  // through the host (`find` op), which reports how many and which.
  const [finding, setFinding] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findHits, setFindHits] = useState<{ index: number; total: number } | null>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const runFind = async (query: string, direction: 'next' | 'prev' | 'first' = 'first') => {
    if (!query) { setFindHits(null); return; }
    try {
      const r = (await tauri.browser.ui('find', { query, direction })) as { index?: number; total?: number };
      setFindHits({ index: r.index ?? 0, total: r.total ?? 0 });
    } catch { setFindHits(null); }
  };
  const closeFind = () => {
    setFinding(false);
    setFindQuery('');
    setFindHits(null);
    void tauri.browser.ui('find', { query: '' }).catch(() => {});
  };
  // The shortcuts every browser has. They reach us while the focus is in the
  // app (address bar, tabs, chat); inside the native page the page has the
  // keys, and Ctrl+L is the way back.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 't' && e.shiftKey) { e.preventDefault(); void reopenTab(); }
      else if (k === 't') { e.preventDefault(); void newTab(); }
      else if (k === 'w') { e.preventDefault(); if (active != null) void closeTab(active); }
      else if (k === 'l') { e.preventDefault(); addressRef.current?.focus(); }
      else if (k === 'f' && url) { e.preventDefault(); setFinding(true); requestAnimationFrame(() => findRef.current?.focus()); }
      else if ((k === '=' || k === '+') && url) { e.preventDefault(); zoomRef.current(zoomRef.current.level + 0.1); }
      else if (k === '-' && url) { e.preventDefault(); zoomRef.current(zoomRef.current.level - 0.1); }
      else if (k === '0' && url) { e.preventDefault(); zoomRef.current(1); }
    };
    window.addEventListener('keydown', onKey);
    // The same keys pressed while the PAGE has the focus: the page is a native
    // view and its key events never reach this window, so the host relays
    // them (browser://key) and they land in the same handler.
    const off = listen<{ key: string; shift?: boolean }>('browser://key', (e) => {
      onKey({ key: e.payload.key, shiftKey: !!e.payload.shift, ctrlKey: true, metaKey: false, preventDefault() {} } as unknown as globalThis.KeyboardEvent);
    });
    return () => { window.removeEventListener('keydown', onKey); void off.then((f) => f()); };
  }, [active, url, newTab, closeTab, reopenTab]);
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
  // A new tab is for typing into. `autoFocus` fires once per mount, and the
  // native page grabs the focus when it is parked, so opening a second tab
  // left the cursor nowhere and cost a click (20 Sep). Focus follows the
  // active tab onto the new-tab page instead.
  const startInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (url) return;
    // The native webview for the new tab is created a beat after React has
    // painted the new-tab page and takes the focus with it; one frame was
    // not enough (20 Sep). Reclaim it a few times across the first half
    // second, then stop: past that the person may have clicked elsewhere.
    const timers = [30, 150, 350, 600].map((ms) =>
      window.setTimeout(() => {
        const el = startInputRef.current;
        if (el && document.activeElement !== el) el.focus();
      }, ms),
    );
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [url, active]);
  // The address bar's memory (see lib/browserHistory): visits with titles,
  // ranked by frecency and by what was picked for these letters before.
  const [history, setHistory] = useState(() => loadHistory());
  useEffect(() => {
    setHistory((prev) => {
      const next = recordVisit(prev, url, current?.title ?? '');
      if (next !== prev) saveHistory(next);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  useEffect(() => {
    if (!current?.title || !url) return;
    setHistory((prev) => {
      const next = recordTitle(prev, url, current.title);
      if (next !== prev) saveHistory(next);
      return next;
    });
  }, [current?.title, url]);
  const [bookmarks, setBookmarks] = useState(() => loadBookmarks());
  const bookmarked = bookmarks.find((b) => b.url === url) ?? null;
  const [starOpen, setStarOpen] = useState(false);
  const [tagText, setTagText] = useState('');
  // Sparks fly off the star when a page is saved: a counter so every save
  // restarts the animation (a fresh key remounts the sparks).
  const [sparks, setSparks] = useState(0);
  const commitBookmark = () => {
    setBookmarks((prev) => {
      const next = upsertBookmark(prev, { url, title: current?.title || display(url), tags: parseTags(tagText) });
      saveBookmarks(next);
      return next;
    });
    setStarOpen(false);
    setSparks((n) => n + 1);
  };
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const downloadCount = useBrowser((b) => b.downloads.length);
  // One zoom level for the browser, remembered across restarts.
  const [zoom, setZoom] = useState(() => Number(readLocal(ZOOM_KEY)) || 1);
  const applyZoom = (factor: number) => {
    const f = Math.round(Math.min(3, Math.max(0.5, factor)) * 10) / 10;
    setZoom(f);
    writeLocal(ZOOM_KEY, String(f));
    void tauri.browser.ui('zoom', { factor: f }).catch(() => {});
  };
  zoomRef.current = Object.assign((f: number) => applyZoom(f), { level: zoom });
  useEffect(() => { if (url && zoom !== 1) void tauri.browser.ui('zoom', { factor: zoom }).catch(() => {}); }, [url]); // eslint-disable-line react-hooks/exhaustive-deps
  const dropBookmark = () => {
    setBookmarks((prev) => { const next = removeBookmark(prev, url); saveBookmarks(next); return next; });
    setStarOpen(false);
  };
  const bookmarkedUrls = useMemo(() => new Set(bookmarks.map((b) => b.url)), [bookmarks]);
  const addressSugg = useAddressSuggestions(history, address, editing, bookmarkedUrls);
  const startSugg = useAddressSuggestions(history, startQuery, !url, bookmarkedUrls);
  const pick = (typed: string, target: string) => {
    setHistory((prev) => { const next = recordPick(prev, typed, target); saveHistory(next); return next; });
    void open(target);
  };
  const keys = (sugg: ReturnType<typeof useAddressSuggestions>, typed: string) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sugg.move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sugg.move(-1); }
    else if (e.key === 'Escape') { sugg.setIndex(-1); e.currentTarget.blur(); }
    else if (e.key === 'Enter' && sugg.selected) { e.preventDefault(); setEditing(false); pick(typed, sugg.selected.url); }
  };
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
    // A call frames the page itself; this re-runs and places it back here when the call ends.
    if (!el || !settled || inCall) return;
    // A modal is open: the page is parked until it closes, then placed again.
    if (covered > 0) { void tauri.browser.ui('set_bounds', { visible: false }).catch(() => {}); return; }
    let frame = 0;
    const report = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Never mid-slide. A native webview resize is a window resize the page
        // relayouts for, and doing it while the nav or the chat drawer is
        // animating stalled both for a second or two (17 Sep). Deferred to the
        // end of the slide, where the rectangle is final anyway.
        onPanelMotionSettled(() => {
          const r = el.getBoundingClientRect();
          void tauri.browser
            .ui('set_bounds', { x: r.left, y: r.top, width: r.width, height: r.height, visible: true })
            .catch(() => {});
        });
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
  }, [settled, inCall, covered]);

  // Leaving by any route (route change, unmount) parks the page.
  useEffect(() => () => void tauri.browser.ui('set_bounds', { visible: false }).catch(() => {}), []);

  // A window reload (Ctrl+R) tears down React without unmounting anything, and
  // the page is a NATIVE child webview the host placed: it kept floating over
  // the loading screen, on top, until something placed it again. React's
  // cleanup never runs here, so the park has to be asked for before the
  // document goes away.
  //
  // ponytail: `pagehide` as well as `beforeunload` — Chromium fires the first
  // reliably on reload, the second not at all in some teardown paths. If the
  // webview is ever killed outright (a crash, not a reload) nothing runs and
  // the page would float again; the fix for that is a heartbeat from the panel
  // with a host-side watchdog, worth writing only if it actually happens.
  useEffect(() => {
    const park = () => void tauri.browser.ui('set_bounds', { visible: false }).catch(() => {});
    window.addEventListener('beforeunload', park);
    window.addEventListener('pagehide', park);
    return () => {
      window.removeEventListener('beforeunload', park);
      window.removeEventListener('pagehide', park);
    };
  }, []);

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
            {t.loading
              ? <Loader2 size={12} className="shrink-0 animate-spin" />
              : t.url.startsWith('http') && <Favicon url={t.url} label={t.title || t.url} px={12} />}
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
        <div className="relative min-w-0 flex-1">
          <input
            ref={addressRef}
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
            onKeyDown={keys(addressSugg, address)}
            className="h-8 w-full min-w-0 rounded-full border border-border-default bg-bg-elevated px-3 text-xs text-text-primary outline-hidden focus:border-brand"
          />
          <AddressSuggestions items={addressSugg.items} index={addressSugg.index} onPick={(s) => pick(address, s.url)} onHover={addressSugg.setIndex} />
        </div>
        <div className="relative">
          <ChromeButton
            label={bookmarked ? 'Edit bookmark' : 'Bookmark this page'}
            icon={Star}
            disabled={!url}
            onClick={() => {
              // One press saves it, with the sparks. The editor (tags, remove)
              // is for a page already saved; typing tags first was a chore.
              if (!bookmarked) { setTagText(''); commitBookmark(); return; }
              setTagText(bookmarked.tags.join(', '));
              setStarOpen((v) => !v);
            }}
            className={cn(bookmarked && 'text-brand [&>svg]:fill-current', sparks > 0 && 'star-pop')}
            key={`star-${sparks}`}
          />
          {sparks > 0 && (
            <span key={sparks} className="pointer-events-none absolute inset-0" aria-hidden>
              {Array.from({ length: 8 }, (_, i) => (
                <i key={i} className="spark" style={{ '--a': `${i * 45}deg` } as CSSProperties} />
              ))}
            </span>
          )}
        </div>
        <ChromeButton
          label={readerOn ? 'Leave reader view' : 'Reader view'}
          icon={BookOpen}
          disabled={!url}
          pressed={readerOn}
          onClick={() => {
            void tauri.browser.ui('reader').then((r) => {
              const out = r as { ok?: boolean; error?: string };
              if (out?.ok === false) useBrowser.setState({ notice: out.error ?? 'No article on this page to read.' });
            }).catch(() => {});
          }}
        />
        <div className="relative">
          <ChromeButton label="Downloads" icon={Download} pressed={downloadsOpen} onClick={() => setDownloadsOpen((v) => !v)} />
          {downloadCount > 0 && (
            <span className="pointer-events-none absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-brand px-1 text-center text-[10px] font-semibold leading-4 text-brand-foreground" aria-hidden>
              {downloadCount > 9 ? '9+' : downloadCount}
            </span>
          )}
        </div>
        {(current?.blocked ?? 0) > 0 && (
          <button
            type="button"
            onClick={() => setSettingsOpen((v) => !v)}
            title={`${current?.blocked} ads and trackers blocked on this page`}
            className="flex shrink-0 items-center gap-1 rounded-full bg-bg-hover px-2 py-0.5 text-2xs font-medium text-text-secondary hover:text-text-primary"
          >
            <ShieldCheck size={12} /> {current?.blocked}
          </button>
        )}
        {zoom !== 1 && (
          <button type="button" onClick={() => applyZoom(1)} title="Reset zoom (Ctrl+0)" className="shrink-0 rounded-full bg-bg-hover px-2 py-0.5 text-2xs font-medium text-text-secondary hover:text-text-primary">
            {Math.round(zoom * 100)}%
          </button>
        )}
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
      {/* Popovers sit in the flow, under the toolbar, and push the page down:
          the page is a native view and paints over anything absolute, which is
          where the Downloads card went (21 Sep). */}
      {starOpen && url && (
        <form
          className="flex flex-col gap-2 border-b border-border-subtle bg-bg-elevated/40 px-3 py-3 text-xs"
          onSubmit={(e) => { e.preventDefault(); commitBookmark(); }}
        >
          <p className="truncate font-medium text-text-primary">{current?.title || display(url)}</p>
          <p className="truncate text-2xs text-text-muted">{display(url)}</p>
          <input
            autoFocus
            aria-label="Tags"
            value={tagText}
            placeholder="tags, comma separated (docs, api, to-read)"
            onChange={(e) => setTagText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setStarOpen(false); }}
            className="h-7 rounded-md border border-border-default bg-bg-elevated px-2 text-xs text-text-primary outline-hidden focus:border-brand"
          />
          <div className="flex items-center justify-between">
            {bookmarked
              ? <button type="button" onClick={dropBookmark} className="text-2xs text-text-muted hover:text-error">Remove</button>
              : <span />}
            <button type="submit" className="rounded-md bg-brand px-2 py-1 text-2xs font-medium text-brand-foreground">Save</button>
          </div>
        </form>
      )}
      {downloadsOpen && (
        <div className="border-b border-border-subtle bg-bg-elevated/40 px-3 py-3 text-xs">
          <DownloadsList />
        </div>
      )}
      {settingsOpen && <BrowserSettings engine={engine} onEngine={setEngine} />}
      {/* Floating over the toolbar, never in the flow: as a row of its own it
          pushed the whole page down and back up on every agent action, which
          read as the browser resizing (17 Sep). The page is a native view and
          always paints above this, so it sits over the chrome, not the page. */}
      <div className="relative h-0">
        {agent && (
          <p
            role="status"
            className="absolute left-1/2 top-0 z-10 flex -translate-x-1/2 -translate-y-full items-center gap-2 whitespace-nowrap rounded-full border border-brand/30 bg-bg-elevated px-3 py-1 text-2xs text-text-primary shadow-md"
          >
            <span className={cn('size-2 shrink-0 rounded-full bg-brand', agent.busy && 'animate-pulse')} aria-hidden />
            {agentLine(agent)}
          </p>
        )}
      </div>
      {error && <p className="border-y border-border-subtle px-3 py-2 text-2xs text-(--warning)">{error}</p>}
      {notice && !error && <p className="border-y border-border-subtle px-3 py-2 text-2xs text-text-muted">{notice}</p>}
      {finding && (
        <form
          className="flex items-center gap-2 border-b border-border-subtle bg-popover px-3 py-1.5"
          onSubmit={(e) => { e.preventDefault(); void runFind(findQuery, 'next'); }}
        >
          <input
            ref={findRef}
            aria-label="Find in page"
            value={findQuery}
            placeholder="Find in page"
            spellCheck={false}
            onChange={(e) => { setFindQuery(e.target.value); void runFind(e.target.value, 'first'); }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
              else if (e.key === 'Enter') { e.preventDefault(); void runFind(findQuery, e.shiftKey ? 'prev' : 'next'); }
            }}
            className="h-7 min-w-0 flex-1 rounded-md border border-border-default bg-bg-elevated px-2 text-xs text-text-primary outline-hidden focus:border-brand"
          />
          <span className="w-16 text-right text-2xs tabular-nums text-text-muted">
            {findHits ? (findHits.total ? `${findHits.index + 1} / ${findHits.total}` : 'no match') : ''}
          </span>
          <ChromeButton label="Previous match" icon={ChevronUp} onClick={() => void runFind(findQuery, 'prev')} />
          <ChromeButton label="Next match" icon={ChevronDown} onClick={() => void runFind(findQuery, 'next')} />
          <ChromeButton label="Close find" icon={X} onClick={closeFind} />
        </form>
      )}
      {/* The page is a native webview and paints over everything React draws,
          the resize handle included: it could only be grabbed in the header,
          where no page is (20 Sep). The body starts after the handle's 6 px,
          so the page's rectangle, reported from this element, never covers it. */}
      <div className={cn('flex min-h-0 flex-1', !wide && 'pl-1.5')}>
      <div ref={bodyRef} className="relative min-w-0 flex-1 bg-white">
        {!url && (
          // The new-tab page, until the first address: a search and the usual
          // first stops. After that the native page covers this area.
          // The new-tab page. The same glass as the rest of the app, not a
          // flat grey: this is the one screen a person sees every time they
          // open the browser, and grey read as a placeholder (17 Sep).
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-8 overflow-y-auto bg-(--surface-typing) px-8 py-10 liquid-glass">
            <div className="flex flex-col items-center gap-3">
              <EngineMark engine={engine} px={96} />
              <p className="text-lg font-medium text-text-primary">{SEARCH_ENGINES[engine]?.label ?? 'DuckDuckGo'}</p>
            </div>
            <form
              className="relative flex w-full max-w-2xl items-center gap-3 rounded-full border border-border-default bg-bg-elevated px-5 py-3 shadow-lg focus-within:border-brand"
              onSubmit={(e) => {
                e.preventDefault();
                if (startSugg.selected) { pick(startQuery, startSugg.selected.url); return; }
                void open(startQuery);
              }}
            >
              <AddressSuggestions
                items={startSugg.items}
                index={startSugg.index}
                onPick={(s) => pick(startQuery, s.url)}
                onHover={startSugg.setIndex}
                className="top-full text-left"
              />
              <Search size={20} className="shrink-0 text-text-muted" />
              <input
                ref={startInputRef}
                autoFocus
                aria-label="Search the web"
                value={startQuery}
                onKeyDown={keys(startSugg, startQuery)}
                placeholder={`Search ${SEARCH_ENGINES[engine]?.label ?? 'DuckDuckGo'} or type an address`}
                spellCheck={false}
                onChange={(e) => setStartQuery(e.target.value)}
                className="min-w-0 flex-1 bg-transparent text-base text-text-primary outline-hidden placeholder:text-text-muted"
              />
            </form>
            {bookmarks.length > 0 && (
              <div className="flex max-w-2xl flex-wrap justify-center gap-2">
                {findBookmarks(bookmarks, startQuery, 12).map((b) => (
                  <button
                    key={b.url}
                    type="button"
                    onClick={() => void open(b.url)}
                    title={b.tags.length ? `#${b.tags.join(' #')}` : b.url}
                    className="flex max-w-56 items-center gap-1.5 rounded-full border border-border-default bg-bg-elevated px-3 py-1 text-xs text-text-secondary hover:border-brand hover:text-text-primary"
                  >
                    <Star size={11} className="shrink-0 text-brand" aria-hidden />
                    <span className="truncate">{b.title || display(b.url)}</span>
                  </button>
                ))}
              </div>
            )}
            {/* The engines as marks only: pick one and the box searches with it. */}
            <div role="radiogroup" aria-label="Search engine" className="flex items-center gap-2">
              {Object.entries(SEARCH_ENGINES).map(([id, e]) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={engine === id}
                  aria-label={e.label}
                  title={e.label}
                  onClick={() => setEngine(id)}
                  className={cn(
                    'flex size-10 items-center justify-center rounded-full border transition-colors',
                    engine === id
                      ? 'border-brand bg-brand/10'
                      : 'border-transparent opacity-60 hover:border-border-subtle hover:bg-bg-hover hover:opacity-100',
                  )}
                >
                  <EngineMark engine={id} size={20} />
                </button>
              ))}
            </div>
            <div className="grid w-full max-w-2xl grid-cols-5 gap-3">
              {SHORTCUTS.map((s) => (
                <button
                  key={s.url}
                  type="button"
                  onClick={() => void open(s.url)}
                  className="flex flex-col items-center gap-2 rounded-xl border border-border-subtle bg-bg-elevated/60 px-2 py-3 text-xs text-text-secondary hover:border-border-default hover:bg-bg-hover hover:text-text-primary"
                >
                  <Favicon url={s.url} label={s.label} />
                  <span className="truncate">{s.label}</span>
                </button>
              ))}
            </div>
            <p className="text-xs text-text-secondary">Cinderpaw can use this browser too; what it does shows here.</p>
          </div>
        )}
      </div>
      {wide && chat && (
        // Beside the page, at the chat column's own minimum width, so the
        // composer and the transcript are the ones the person already knows.
        //
        // Mounted for the whole of wide mode and merely HIDDEN when shut, not
        // mounted on each press: the column is the entire transcript, and
        // building it in the frame the drawer opens is what made the bubble
        // take a second or two to appear (17 Sep, same defect as the nav rail).
        // `hidden` is display:none — the rows keep their state and cost no
        // layout while shut.
        <div
          hidden={!chatOpen}
          className="flex w-[28rem] shrink-0 flex-col border-l border-border-default bg-bg-surface"
        >
          {chat}
        </div>
      )}
      </div>
    </motion.aside>
  );
}

/** What the host says about the built-in ad blocker (`browser://adblock`). */
interface AdblockStatus {
  state: 'off' | 'loading' | 'on' | 'failed';
  what?: string;
  rules?: number;
  updatedMs?: number;
  error?: string;
  /** Requests are intercepted on this system (Windows for now). */
  supported: boolean;
}

function adblockHint(s: AdblockStatus | null): string {
  if (!s) return 'Brave’s engine with EasyList and EasyPrivacy, built in.';
  if (!s.supported) return 'Not on this system yet: pages are not filtered here. Windows only for now.';
  switch (s.state) {
    case 'off': return 'Off. Ads and trackers load like in a browser without a blocker.';
    case 'loading': return `${s.what ?? 'Loading'}…`;
    case 'failed': return `Could not load the block lists: ${s.error ?? 'unknown error'}. Check the connection and turn it off and on again.`;
    default: return `Brave’s engine, ${(s.rules ?? 0).toLocaleString()} rules from EasyList, EasyPrivacy and uBlock, refreshed weekly.`;
  }
}

/**
 * The browser's own settings: which engine answers the bar, the built-in ad
 * blocker (Brave's `adblock` engine in the host, on by default), and the
 * extensions folder. uBlock Origin Lite stays as an optional extension,
 * fetched from its GitHub release on the person's press (GPLv3; not bundled
 * with an Apache-2.0 app). Extensions are Windows only, and a new one is
 * picked up when Cinderpaw next starts, because the browser environment is
 * created once with the first tab.
 */
function BrowserSettings({ engine, onEngine }: { engine: string; onEngine: (e: string) => void }) {
  const [ext, setExt] = useState<{ path: string; extensions: Array<{ name: string; version: string }> } | null>(null);
  const [adblock, setAdblock] = useState<AdblockStatus | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [cleared, setCleared] = useState<string | null>(null);
  const refresh = () => {
    void tauri.browser.ui('extensions').then((r) => setExt(r as never)).catch(() => setExt(null));
  };
  useEffect(refresh, []);
  useEffect(() => {
    void tauri.browser.ui('adblock').then((r) => setAdblock(r as unknown as AdblockStatus)).catch(() => setAdblock(null));
    const un = listen<AdblockStatus>('browser://adblock', (e) => setAdblock(e.payload));
    return () => { void un.then((f) => f()).catch(() => {}); };
  }, []);
  const hasBlocker = ext?.extensions.some((e) => /ublock/i.test(e.name)) ?? false;
  const isWindows = navigator.userAgent.includes('Windows');
  const btn = cn(SECONDARY_BUTTON, 'shrink-0 text-xs');
  const adblockOn = adblock !== null && adblock.state !== 'off';

  return (
    <div className="flex flex-col divide-y divide-border-subtle border-b border-border-subtle bg-bg-elevated/40 px-4">
      <SettingRow title="Search with" hint="Where words typed in the address bar go.">
        <SelectMenu
          value={engine}
          onChange={onEngine}
          ariaLabel="Search engine"
          options={Object.entries(SEARCH_ENGINES).map(([id, e]) => ({ value: id, label: e.label }))}
        />
      </SettingRow>
      <SettingRow title="Ad blocker" hint={adblockHint(adblock)}>
        <button
          type="button"
          role="switch"
          aria-checked={adblockOn}
          aria-label="Ad blocker"
          disabled={adblock === null || adblock.state === 'loading'}
          onClick={() => {
            void tauri.browser.ui('adblock_set', { on: !adblockOn }).then((r) => setAdblock(r as unknown as AdblockStatus)).catch(() => {});
          }}
          className={cn(
            'inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-default disabled:opacity-60',
            adblockOn ? 'bg-brand hover:bg-brand-hover' : 'bg-border-default hover:bg-bg-hover',
          )}
        >
          <span className={cn('inline-block h-4 w-4 rounded-full bg-white shadow transition-transform duration-200', adblockOn ? 'translate-x-[18px]' : 'translate-x-[2px]')} />
        </button>
      </SettingRow>
      <SettingRow
        title="uBlock Origin Lite"
        hint={!isWindows
          ? 'Browser extensions are not available on this system yet.'
          : installing && installing !== 'busy'
            ? installing
            : 'The extension Chrome users install, on top of the built-in blocker. It starts when Cinderpaw next opens.'}
      >
        {isWindows && (hasBlocker
          ? <span className="flex shrink-0 items-center gap-1 text-xs text-text-secondary"><ShieldCheck size={14} /> Installed</span>
          : (
            <button
              type="button"
              disabled={installing === 'busy'}
              onClick={() => {
                setInstalling('busy');
                tauri.browser.ui('install_adblock')
                  .then(() => { setInstalling('Installed. It starts blocking when Cinderpaw next opens.'); refresh(); })
                  .catch((e) => setInstalling(`Could not install: ${String(e)}`));
              }}
              className={btn}
            >
              {installing === 'busy' ? 'Downloading…' : 'Install'}
            </button>
          ))}
      </SettingRow>
      {ext && isWindows && (
        <SettingRow
          title="Extensions"
          hint={ext.extensions.length > 0
            ? ext.extensions.map((e) => `${e.name} ${e.version}`).join(', ')
            : 'Drop an unpacked Chrome extension in the folder; it loads when Cinderpaw next opens.'}
        >
          <button type="button" onClick={() => void shellOpen(ext.path)} className={btn}>Open folder</button>
        </SettingRow>
      )}
      <SettingRow title="Site data" hint={cleared ?? 'Cookies, cache and storage every site kept. Clearing signs you out everywhere.'}>
        {!cleared && (
          <button
            type="button"
            onClick={() => {
              void tauri.browser.ui('clear_data')
                .then(() => setCleared('Cleared. Sites have forgotten you; sign in again where you need to.'))
                .catch((e: unknown) => setCleared(`Could not clear: ${String(e)}`));
            }}
            className={btn}
          >
            Clear
          </button>
        )}
      </SettingRow>
      <SettingRow title="Developer tools" hint="Inspect this page the way Chrome's DevTools do.">
        <button type="button" onClick={() => void tauri.browser.ui('devtools').catch(() => {})} className={btn}>Inspect</button>
      </SettingRow>
    </div>
  );
}

/** One settings row: what it is and why on the left, the control on the right. */
function SettingRow({ title, hint, children }: { title: string; hint: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-xs font-medium text-text-primary">{title}</p>
        <p className="mt-0.5 text-2xs text-text-muted">{hint}</p>
      </div>
      {children}
    </div>
  );
}

/** This session's downloads, newest first, each one openable. */
function DownloadsList() {
  const downloads = useBrowser((b) => b.downloads);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-2xs uppercase tracking-wide text-text-muted">Downloads</span>
      {downloads.length === 0 && <span className="text-2xs text-text-muted">Nothing downloaded yet this session.</span>}
      {downloads.slice(0, 8).map((d) => (
        <div key={`${d.name}-${d.at}`} className="flex items-center gap-2 text-2xs">
          <span className="min-w-0 flex-1 truncate text-text-primary">{d.name}</span>
          {d.error
            ? <span className="text-error">{d.error}</span>
            : d.artifact
              ? <span className="text-text-muted">in Artifacts</span>
              : d.dest
                ? <button type="button" onClick={() => void shellOpen(d.dest!)} className="text-text-muted underline-offset-2 hover:underline">Open</button>
                : null}
        </div>
      ))}
    </div>
  );
}

/** What the agent is doing, in a few words. */
function agentLine(a: { op: string; url?: string; ref?: string; busy: boolean }): string {
  const what: Record<string, string> = {
    open: a.url ? `Cinderpaw is opening ${a.url}` : 'Cinderpaw is opening a page',
    snapshot: 'Cinderpaw is reading this page',
    click: a.ref ? `Cinderpaw clicked control ${a.ref}` : 'Cinderpaw clicked',
    type: a.ref ? `Cinderpaw typed into control ${a.ref}` : 'Cinderpaw typed',
    scroll: 'Cinderpaw scrolled', back: 'Cinderpaw went back', forward: 'Cinderpaw went forward',
    reload: 'Cinderpaw reloaded the page',
    paused: 'You took over; Cinderpaw paused and will ask before continuing',
  };
  const line = what[a.op] ?? `Cinderpaw: ${a.op}`;
  return a.busy ? `${line}…` : line;
}

/** A site's own icon, or its initial while it loads or when it has none. */
function Favicon({ url, label, px = 32 }: { url: string; label: string; px?: number }) {
  const [failed, setFailed] = useState(false);
  const origin = new URL(url).origin;
  const box = px <= 16 ? 'size-3 rounded-sm text-[9px]' : 'size-8 rounded-lg text-sm';
  if (failed) {
    return (
      <span className={cn('flex shrink-0 items-center justify-center bg-bg-hover font-semibold text-text-secondary', box)} aria-hidden>
        {label.charAt(0)}
      </span>
    );
  }
  return (
    <img
      src={`${origin}/favicon.ico`}
      alt=""
      width={px}
      height={px}
      className={cn('shrink-0', box)}
      onError={() => setFailed(true)}
    />
  );
}

/** A search engine's mark in its own colour; an initial for one without a mark. */
/** `px`, not `size`: this draws a brand mark at any size, and the icon
 *  scale in src/test/scale.test.ts is about icons. The start page wants 96. */
function EngineMark({ engine, size, px }: { engine: string; size?: number; px?: number }) {
  size = size ?? px ?? 20;
  const logo = ENGINE_LOGOS[engine];
  if (!logo) {
    return (
      <span
        aria-hidden
        style={{ width: size, height: size, fontSize: Math.max(10, size * 0.45) }}
        className="inline-flex items-center justify-center rounded-full bg-bg-hover font-semibold uppercase text-text-secondary"
      >
        {(SEARCH_ENGINES[engine]?.label ?? engine).charAt(0)}
      </span>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden style={{ fill: logo.hex }}>
      <path d={logo.path} />
    </svg>
  );
}

function ChromeButton({
  label, icon: Icon, onClick, spin, disabled, pressed, className,
}: {
  label: string;
  icon: typeof Globe;
  onClick: () => void;
  spin?: boolean;
  disabled?: boolean;
  /** A toggle's on state: announced, and drawn in the brand colour. */
  pressed?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn('flex size-8 shrink-0 items-center justify-center rounded-full text-text-muted hover:bg-bg-hover hover:text-text-primary disabled:opacity-40 disabled:hover:bg-transparent', pressed && 'bg-brand/15 text-brand', className)}
    >
      <Icon size={16} className={cn(spin && 'animate-spin')} />
    </button>
  );
}
