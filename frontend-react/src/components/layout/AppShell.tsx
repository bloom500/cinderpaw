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
      <motion.main
        animate={{ paddingLeft: (collapsed ? SIDEBAR_COLLAPSED_W : SIDEBAR_W) + 16 }}
        transition={{ duration: 0.22, ease: 'easeInOut' }}
        className="absolute inset-0 flex flex-col overflow-hidden"
      >
        <Outlet />
      </motion.main>
      {/* Window controls — fixed top-right, always on top of all pages */}
      <div className="fixed top-0 right-0 z-40 flex items-center">
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
      <div className="fixed top-11 right-4 z-[100] w-80 flex flex-col gap-2 pointer-events-none">
        <UpdateToast />
        <Toasts />
      </div>
      <SkillHubDrawer />
      <OnboardingOrchestrator />
    </div>
  );
}
