import { Outlet } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useUI, useSystemThemeSync } from '@/stores/ui';
import { useGlobalHotkeys } from '@/hooks/useGlobalHotkeys';
import { Sidebar, SIDEBAR_W, SIDEBAR_COLLAPSED_W } from './Sidebar';
import { SearchOverlay } from '@/components/chat/SearchOverlay';

export function AppShell() {
  useSystemThemeSync();
  useGlobalHotkeys();

  const collapsed   = useUI((s) => s.sidebarCollapsed);
  const searchOpen  = useUI((s) => s.searchOpen);

  return (
    <div className="h-screen w-screen flex bg-bg-primary text-text-primary overflow-hidden">
      <Sidebar />
      <motion.main
        animate={{ marginLeft: collapsed ? SIDEBAR_COLLAPSED_W : SIDEBAR_W }}
        transition={{ duration: 0.22, ease: 'easeInOut' }}
        className="flex-1 flex flex-col min-w-0"
      >
        <Outlet />
      </motion.main>
      {searchOpen && <SearchOverlay />}
    </div>
  );
}
