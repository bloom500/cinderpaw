import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Minus, Square, X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useUI, useSystemThemeSync } from '@/stores/ui';
import { useUpdater } from '@/stores/updater';
import { useGlobalHotkeys } from '@/hooks/useGlobalHotkeys';
import { Sidebar, SIDEBAR_W, SIDEBAR_COLLAPSED_W } from './Sidebar';
import { SearchOverlay } from '@/components/chat/SearchOverlay';
import { UpdateToast } from '@/components/UpdateToast';
import { SkillHubDrawer } from '@/components/SkillHubDrawer';
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

  const collapsed   = useUI((s) => s.sidebarCollapsed);
  const searchOpen  = useUI((s) => s.searchOpen);

  // Silent update check once on startup; the toast appears only if one is available.
  const checkForUpdate = useUpdater((s) => s.check);
  useEffect(() => { void checkForUpdate(); }, [checkForUpdate]);

  return (
    <div className="h-screen w-screen flex bg-bg-primary text-text-primary overflow-hidden">
      <Sidebar />
      <motion.main
        animate={{ marginLeft: (collapsed ? SIDEBAR_COLLAPSED_W : SIDEBAR_W) + 16 }}
        transition={{ duration: 0.22, ease: 'easeInOut' }}
        className="flex-1 flex flex-col min-w-0"
      >
        <Outlet />
      </motion.main>
      {/* Window controls — fixed top-right, always on top of all pages */}
      <div className="fixed top-0 right-0 z-40 flex items-center">
        <WinControls />
      </div>
      {searchOpen && <SearchOverlay />}
      <UpdateToast />
      <SkillHubDrawer />
    </div>
  );
}
