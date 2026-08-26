Exit code: 0
Wall time: 0.7 seconds
Output:
import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Minus, Square, X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useUI, useSystemThemeSync } from '@/stores/ui';
import { useUpdater } from '@/stores/updater';
import { useGlobalHotkeys } from '@/hooks/useGlobalHotkeys';
import { useDreamCycle } from '@/hooks/useDreamCycle';
import { DownloadStatus } from './DownloadStatus';
import { SideNav, NAV_W, NAV_COLLAPSED_W } from './SideNav';
import { SearchOverlay } from '@/components/chat/SearchOverlay';
import { UpdateToast } from '@/components/UpdateToast';
import { Toasts } from '@/components/Toasts';
import { SkillHubDrawer } from '@/components/SkillHubDrawer';
import { OnboardingOrchestrator } from '@/components/onboarding/OnboardingWizard';
import { cn } from '@/lib/utils';

// The `/40` these three carried never actually rendered: an opacity modifier on
// a hex-in-a-var compiled to an unparseable colour, the declaration was dropped,
// and they inherited full-strength text instead. Fixing the tokens made the 40%
// real and turned the minimise / maximise / close controls into ghosts. Window
// chrome is the one thing that must always be findable.
function WinControls() {
  return (
    <div className="flex items-center shrink-0">
      <button
        type="button"
        onClick={() => void getCurrentWindow().minimize()}
        className="h-8 w-10 flex items-center justify-center text-text-muted/70 hover:text-text-primary hover:bg-white/5 transition-colors"
        aria-label="Minimize"
      >
        <Minus size={13} strokeWidth={1.5} />
      </button>
      <button
        type="button"
        onClick={() => void getCurrentWindow().toggleMaximize()}
        className="h-8 w-10 flex items-center justify-center text-text-muted/70 hover:text-text-primary hover:bg-white/5 transition-colors"
        aria-label="Maximize"
      >
        <Square size={11} strokeWidth={1.5} />
      </button>
      <button
        type="button"
        onClick={() => void getCurrentWindow().close()}
        className={cn(
          'h-8 w-10 flex items-center justify-center text-text-muted/70 transition-colors',
          'hover:text-white hover:bg-red-500/80',
        )}
        aria-label="Close"
      >
        <X size={13} strokeWidth={1.5} />
      </button>
    </div>
  );
}

export function AppShell() {
  useSystemThemeSync();
  useGlobalHotkeys();
  useDreamCycle();

  const navCollapsed = useUI((s) => s.navCollapsed);
  const searchOpen   = useUI((s) => s.searchOpen);

  // Silent update check once on startup; the toast appears only if one is available.
  // Opt-out via Settings → General (privacy: the check contacts GitHub Releases).
  const checkForUpdate = useUpdater((s) => s.check);
  useEffect(() => {
    if (localStorage.getItem('cinderpaw.autoUpdateCheck') !== 'off') void checkForUpdate();
  }, [checkForUpdate]);

  return (
    <div className="app-pane h-screen w-screen relative bg-bg-primary text-text-primary overflow-hidden">
      <SideNav />
      {/* pt-14 on main clears the floating nav. The nav is translucent and sits
          over the page by design, but "over" must not mean "on top of the chat
          title": the page starts below it, so what shows through the glass is
          the page's own background rather than text the nav is covering. */}
      <motion.main
        // Collapsed leaves only room for the button that brings it back.
        animate={{ paddingLeft: navCollapsed ? NAV_COLLAPSED_W + 60 : NAV_W + 24 }}
        transition={{ duration: 0.22, ease: 'easeInOut' }}
        className="absolute inset-0 flex flex-col overflow-hidden pt-3 pr-4"
      >
        <Outlet />
      </motion.main>
      {/* The window's drag handle, once, for every page there is and every page
          there will be.
          Each page used to bring its own strip, which meant each page could
          forget — and two had: Connectors and Extensions could not be dragged at
          all, and Chat lost its handle entirely while the agent onboarding was
          on screen, because the header that carried it was not rendered. A
          frameless window that cannot be moved is not a small bug.

          Deliberately placed after `main` and given no z-index: both are
          positioned, so DOM order puts this above the page content and it
          receives the drag. Everything that must stay clickable already sits
          higher — the sidebar at z-30 (its collapse button lives in this band),
          the call overlay at z-100 with a strip of its own, and the window
          controls at z-200.

          Only the element carrying the attribute drags, so a button that ends up
          under this band is still a button: Tauri looks at the event target, not
          at the ancestors. */}
      <div
        data-tauri-drag-region
        aria-hidden
        className="fixed top-0 inset-x-0 h-8"
      />
      {/* Window controls — fixed top-right, above EVERYTHING including
          full-screen overlays and modals. These used to share z-40 with the
          voice-call overlay and got buried by it, leaving a frameless window with
          no way to minimize, maximize or close it. Window chrome is the one layer
          a page must never be able to cover. */}
      {/* Download status rides in the same strip: it is transient application
          state, like the toasts below it, and the sidebar it used to live in
          hid it whenever the rail was collapsed. */}
      <div className="fixed top-0 right-0 z-[200] flex items-center">
        <DownloadStatus />
        <WinControls />
      </div>
      {searchOpen && <SearchOverlay />}
      {/* Notification layer — one column, top-right, tucked under the window
          controls (h-8 = 32px, so top-11 clears them with air to spare). Toasts
          and the update card used to be two separate `fixed` elements: one in
          the bottom-right, colliding with the chat composer, the other in the
          corner beneath it. They now stack together where the eye already goes.
          pointer-events-none so the empty column never swallows clicks meant
          for the page; each card re-enables them. */}
      {/* z-[200], not z-[100]: the call overlay also sits at 100 and, being
          portalled to <body> later in the DOM, painted over every toast — so the
          errors that explain a failed call were invisible exactly when needed. */}
      <div className="fixed top-11 right-4 z-[200] w-80 flex flex-col gap-2 pointer-events-none">
        <UpdateToast />
        <Toasts />
      </div>
      <SkillHubDrawer />
      <OnboardingOrchestrator />
    </div>
  );
}

