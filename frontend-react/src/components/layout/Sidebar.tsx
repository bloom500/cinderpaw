import { motion, AnimatePresence } from 'framer-motion';
import {
  MessageSquare, FolderPlus, Search, Box, Settings, Sparkles,
  Download, PanelLeftClose, PanelLeftOpen, Lock,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useUI } from '@/stores/ui';
import { useConversations, type ConversationSummary } from '@/stores/conversations';

export const SIDEBAR_W = 240;
export const SIDEBAR_COLLAPSED_W = 56;

type MenuAction = 'newChat' | 'newProject' | 'search' | 'models' | 'settings' | 'skills';

interface MenuItem {
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
  label: string;
  shortcut: string | null;
  action: MenuAction;
  disabled: boolean;
  route?: string;
}

const MENU: MenuItem[] = [
  { icon: MessageSquare, label: 'New Chat',     shortcut: '⌘N', action: 'newChat',    disabled: false, route: '/chat' },
  { icon: FolderPlus,    label: 'New Projects', shortcut: '⌘P', action: 'newProject', disabled: true  },
  { icon: Search,        label: 'Search',       shortcut: '⌘K', action: 'search',     disabled: true  },
  { icon: Box,           label: 'Models',       shortcut: null, action: 'models',     disabled: true,  route: '/models' },
  { icon: Settings,      label: 'Settings',     shortcut: null, action: 'settings',   disabled: true,  route: '/settings' },
  { icon: Sparkles,      label: 'Skills',       shortcut: null, action: 'skills',     disabled: true,  route: '/skills' },
];

export function Sidebar() {
  const collapsed = useUI((s) => s.sidebarCollapsed);
  const toggleSidebar = useUI((s) => s.toggleSidebar);

  return (
    <TooltipProvider delayDuration={300}>
      <motion.aside
        animate={{ width: collapsed ? SIDEBAR_COLLAPSED_W : SIDEBAR_W }}
        transition={{ duration: 0.22, ease: 'easeInOut' }}
        className="fixed inset-y-0 left-0 bg-bg-surface flex flex-col z-20 overflow-hidden"
      >
        {/* Header */}
        <div className="h-12 px-3 flex items-center justify-between shrink-0">
          {!collapsed && (
            <span className="font-semibold text-text-primary text-sm select-none">Feral</span>
          )}
          <div className={cn('flex gap-1', collapsed && 'mx-auto')}>
            {!collapsed && (
              <button
                className="p-1.5 rounded hover:bg-bg-hover text-text-muted hover:text-text-secondary"
                aria-label="Downloads"
              >
                <Download size={16} />
              </button>
            )}
            <button
              onClick={toggleSidebar}
              className="p-1.5 rounded hover:bg-bg-hover text-text-muted hover:text-text-secondary"
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </button>
          </div>
        </div>

        {/* Primary menu */}
        <nav className="px-2 py-2 space-y-0.5 shrink-0">
          {MENU.map((item) => (
            <MenuRow key={item.action} item={item} collapsed={collapsed} />
          ))}
        </nav>

        {/* Recent conversations */}
        <div className="flex-1 overflow-y-auto px-2 pt-2 min-h-0">
          <AnimatePresence>
            {!collapsed && <RecentSection />}
          </AnimatePresence>
        </div>

        {/* Footer */}
        <div className="px-3 py-2 shrink-0">
          <AnimatePresence>
            {!collapsed && (
              <motion.span
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="text-[11px] text-text-muted select-none"
              >
                v0.1.0
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      </motion.aside>
    </TooltipProvider>
  );
}

function MenuRow({ item, collapsed }: { item: MenuItem; collapsed: boolean }) {
  const navigate = useNavigate();
  const Icon = item.icon;

  const onClick = () => {
    if (item.disabled) return;
    if (item.action === 'newChat') {
      navigate('/chat');
      window.dispatchEvent(new CustomEvent('feral:new-chat'));
      return;
    }
    if (item.route) navigate(item.route);
  };

  const row = (
    <button
      type="button"
      onClick={onClick}
      disabled={item.disabled}
      aria-label={item.label}
      className={cn(
        'w-full flex items-center gap-3 px-2 py-1.5 rounded text-sm transition-colors',
        item.disabled
          ? 'opacity-60 cursor-not-allowed text-text-muted'
          : 'text-text-primary hover:bg-bg-hover cursor-pointer',
        collapsed && 'justify-center',
      )}
    >
      <Icon size={16} className="shrink-0" />
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.span
            key="label"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="flex-1 text-left truncate"
          >
            {item.label}
          </motion.span>
        )}
        {!collapsed && item.shortcut && (
          <motion.span
            key="shortcut"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="text-[11px] text-text-muted shrink-0"
          >
            {item.shortcut}
          </motion.span>
        )}
        {!collapsed && item.disabled && (
          <motion.span
            key="lock"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="text-text-disabled shrink-0"
          >
            <Lock size={12} />
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  );

  if (item.disabled || collapsed) {
    const tooltipLabel = item.disabled
      ? 'Coming soon'
      : `${item.label}${item.shortcut ? ` (${item.shortcut})` : ''}`;
    return (
      <Tooltip>
        <TooltipTrigger asChild>{row}</TooltipTrigger>
        <TooltipContent side="right">{tooltipLabel}</TooltipContent>
      </Tooltip>
    );
  }
  return row;
}

function RecentSection() {
  const list = useConversations((s) => s.list);
  const currentId = useConversations((s) => s.currentId);
  const open = useConversations((s) => s.open);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
    >
      <div className="flex items-center justify-between px-2 mb-1">
        <span className="text-[11px] uppercase tracking-wider text-text-muted select-none">
          Recent
        </span>
        <button className="text-text-muted hover:text-text-secondary p-0.5 text-sm leading-none" aria-label="More">
          ⋯
        </button>
      </div>
      <div className="space-y-0.5">
        {(!list || list.length === 0) && (
          <div className="px-2 py-1 text-xs text-text-disabled">No conversations yet</div>
        )}
        {(list ?? []).map((c) => (
          <RecentRow key={c.id} conv={c} currentId={currentId} onOpen={open} />
        ))}
      </div>
    </motion.div>
  );
}

function RecentRow({
  conv, currentId, onOpen,
}: {
  conv: ConversationSummary;
  currentId: string | null;
  onOpen: (id: string) => Promise<void>;
}) {
  const isActive = conv.id === currentId;
  return (
    <button
      type="button"
      onClick={() => void onOpen(conv.id)}
      className={cn(
        'w-full text-left px-2 py-1.5 text-sm rounded truncate transition-colors',
        isActive
          ? 'bg-bg-active text-text-primary'
          : 'text-text-secondary hover:bg-bg-hover',
      )}
    >
      {conv.title}
    </button>
  );
}
