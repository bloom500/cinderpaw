import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Minus, Square, X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useUI, useSystemThemeSync } from '@/stores/ui';
import { useUpdater } from '@/stores/updater';
import { useGlobalHotkeys } from '@/hooks/useGlobalHotkeys';
import { useDreamCycle } from '@/hooks/useDreamCycle';
import { Sidebar, SIDEBAR_W, SIDEBAR_COLLAPSED_W } from './Sidebar';
import { DownloadStatus } from './DownloadStatus';
import { TopNav } from './TopNav';
import { SearchOverlay } from '@/components/chat/SearchOverlay';
import { UpdateToast } from '@/components/UpdateToast';
import { Toasts } from '@/components/Toasts';
import { SkillHubDrawer } from '@/components/SkillHubDrawer';
import { OnboardingOrchestrator } from '@/components/onboarding/OnboardingWizard';
import { cn } from '@/lib/utils';

function WinControls() {
  return (
    <div className="flex items-center shrink-0">
      <button
        type="button"
        onClick={() => void getCurrentWindow().minimize()}
        className="h-8 w-10 flex items-center justify-center text-text-muted/40 hover:text-text-muted hover:bg-white/5 transition-colors"
        aria-label="Minimize"
      >
        <Minus size={13} strokeWidth={1.5} />
      </button>
      <button
        type="button"
        onClick={() => void getCurrentWindow().toggleMaximize()}
        className="h-8 w-10 flex items-center justify-center text-text-muted/40 hover:text-text-muted hover:bg-white/5 transition-colors"
        aria-label="Maximize"
      >
        <Square size={11} strokeWidth={1.5} />
      </button>
      <button
        type="button"
        onClick={() => void getCurrentWindow().close()}
        className={cn(
          'h-8 w-10 flex items-center justify-center text-text-muted/40 transition-colors',
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

  const collapsed   = useUI((s) => s.sidebarCollapsed);
  const searchOpen  = useUI((s) => s.searchOpen);

  // Silent update check once on startup; the toast appears only if one is available.
  // Opt-out via Settings → General (privacy: the check contacts GitHub Releases).
  const checkForUpdate = useUpdater((s) => s.check);
  useEffect(() => {
    if (localStorage.getItem('feral.autoUpdateCheck') !== 'off') void checkForUpdate();
  }, [checkForUpdate]);

  return (
    <div className="h-screen w-screen relative bg-bg-primary text-text-primary overflow-hidden">
      <Sidebar />
      {/* The nav is a sibling of the page, not a child of it: an absolutely
          positioned child is placed against the PADDING box, so it starts at
          x=0 and lands on top of the rail rather than beside it. It rides the
          same width the rail animates to, and when S4 deletes the rail this
          whole wrapper collapses to a plain `left-2`. */}
      <motion.div
        animate={{ left: (collapsed ? SIDEBAR_COLLAPSED_W : SIDEBAR_W) + 16 }}
        transition={{ duration: 0.22, ease: 'easeInOut' }}
        className="fixed top-2 z-30"
      >
        <TopNav />
      </motion.div>
      {/* pt-14 on main clears the floating nav. The nav is translucent and sits
          over the page by design, but "over" must not mean "on top of the chat
          title": the page starts below it, so what shows through the glass is
          the page's own background rather than text the nav is covering. */}
      <motion.main
        animate={{ paddingLeft: (collapsed ? SIDEBAR_COLLAPSED_W : SIDEBAR_W) + 16 }}
        transition={{ duration: 0.22, ease: 'easeInOut' }}
        className="absolute inset-0 flex flex-col overflow-hidden pt-14"
      >
        <Outlet />
      </motion.main>
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
