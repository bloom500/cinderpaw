import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, ArrowRight, Globe, Loader2, RotateCw, X } from 'lucide-react';
import { tauri } from '@/lib/tauri';
import { useBrowser } from '@/stores/browser';
import { cn } from '@/lib/utils';

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
  const { url, loading, error, notice, open, go, setPanel } = useBrowser();
  const [address, setAddress] = useState(url);
  const [editing, setEditing] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [settled, setSettled] = useState(false);

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
      aria-label="Browser"
      initial={{ x: 32, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 32, opacity: 0 }}
      transition={{ duration: 0.16, ease: 'easeOut' }}
      onAnimationComplete={() => setSettled(true)}
      className="flex w-[min(640px,55%)] min-w-[360px] shrink flex-col overflow-hidden border-l border-border-default bg-bg-surface"
    >
      {/* pt-6 for the window's own buttons at the top-right, like the Artifacts panel. */}
      <form
        className="flex items-center gap-1 px-2 pb-2 pt-6"
        onSubmit={(e) => {
          e.preventDefault();
          setEditing(false);
          void open(address);
        }}
      >
        <ChromeButton label="Back" icon={ArrowLeft} onClick={() => void go('back')} />
        <ChromeButton label="Forward" icon={ArrowRight} onClick={() => void go('forward')} />
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
          // Only visible before the first page: after that the page covers it.
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-bg-surface px-8 text-center">
            <Globe size={20} className="text-text-muted" />
            <p className="text-xs text-text-muted">
              Type an address or a search above. Cinderpaw can use this browser too, and you see
              what it does here.
            </p>
          </div>
        )}
      </div>
    </motion.aside>
  );
}

function ChromeButton({
  label, icon: Icon, onClick, spin,
}: {
  label: string;
  icon: typeof Globe;
  onClick: () => void;
  spin?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-8 shrink-0 items-center justify-center rounded-full text-text-muted hover:bg-bg-hover hover:text-text-primary"
    >
      <Icon size={16} className={cn(spin && 'animate-spin')} />
    </button>
  );
}
