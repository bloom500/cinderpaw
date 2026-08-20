import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Plus, Search, MessageSquare, Folder, Box, Settings,
  PanelLeftClose, PanelLeftOpen, Loader2, FolderPlus,
} from 'lucide-react';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { NewProjectDialog } from '@/components/items/NewProjectDialog';
import { useUI } from '@/stores/ui';
import { useConversations } from '@/stores/conversations';
import { cn } from '@/lib/utils';

/**
 * Primary navigation. It answers exactly one question — where do I want to go —
 * and the agent answers the other one.
 *
 * Seven rows, and they do not grow. The component it replaces reached nine one
 * reasonable addition at a time, and nothing failed when it did, so the count
 * is pinned by a test rather than by good intentions. Nothing about skills,
 * extensions, connectors, memory, providers, runtimes or evolution appears
 * here: those are reachable in two clicks from Settings and, more often, by
 * asking for them out loud.
 */

export const NAV_W = 216;
export const NAV_COLLAPSED_W = 60;

/**
 * How many recent chats the rail will ever show.
 *
 * Five, and it is a constant with a test on it because this block is the exact
 * road the old rail walked: a list in the navigation grows until it is the
 * navigation. Everything past five lives on the Chats page, which has room to
 * read it and costs no width on a screen where nobody is looking for it.
 */
export const RECENT_LIMIT = 5;

const NAV = [
  { to: '/chats',    icon: MessageSquare, label: 'Chats' },
  { to: '/projects', icon: Folder,        label: 'Projects' },
  { to: '/models',   icon: Box,           label: 'Models' },
] as const;

function Row({
  icon: Icon, label, collapsed, onClick, to, active,
}: {
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
  label: string;
  collapsed: boolean;
  onClick?: () => void;
  to?: string;
  active?: boolean;
}) {
  const inner = (
    <>
      <Icon size={16} className="shrink-0" />
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.span
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="truncate"
          >
            {label}
          </motion.span>
        )}
      </AnimatePresence>
    </>
  );
  const classes = (isActive: boolean) => cn(
    'w-full flex items-center gap-3 h-9 px-3 rounded-xl text-sm transition-colors cursor-pointer',
    collapsed && 'justify-center px-0',
    isActive
      ? 'bg-bg-active text-text-primary'
      : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
  );

  if (to) {
    return (
      <NavLink to={to} title={collapsed ? label : undefined} className={({ isActive }) => classes(isActive)}>
        {inner}
      </NavLink>
    );
  }
  return (
    <button type="button" onClick={onClick} title={collapsed ? label : undefined} className={classes(Boolean(active))}>
      {inner}
    </button>
  );
}

/**
 * The five most recent chats, flat. No grouping by date, no nesting under
 * projects, no counts — a project's chats are the project page's job.
 */
function Recent({ collapsed }: { collapsed: boolean }) {
  const navigate = useNavigate();
  const list = useConversations((s) => s.list);
  const currentId = useConversations((s) => s.currentId);
  const streamingIds = useConversations((s) => s.streamingIds);
  if (collapsed) return null;

  const recent = (list ?? [])
    .slice()
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .slice(0, RECENT_LIMIT);

  return (
    <div className="mt-4 min-h-0 flex flex-col">
      <span className="px-3 pb-1 text-[11px] uppercase tracking-wider text-text-disabled select-none">
        Recent
      </span>
      {recent.length === 0 ? (
        // Not an empty box: a fresh install says why there is nothing here.
        <span className="px-3 py-1 text-xs text-text-disabled">
          Nothing yet. Ask Feral something.
        </span>
      ) : (
        <div className="space-y-0.5 overflow-y-auto scrollbar-hide">
          {recent.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => { void useConversations.getState().open(c.id); navigate('/chat'); }}
              className={cn(
                'w-full flex items-center gap-2 h-8 px-3 rounded-lg text-[13px] text-left transition-colors cursor-pointer',
                c.id === currentId
                  ? 'bg-bg-active text-text-primary'
                  : 'text-text-muted hover:bg-bg-hover hover:text-text-secondary',
              )}
            >
              {/* The dot the old rail had and nothing has had since: a chat can
                  be generating while you are looking at another one. */}
              {streamingIds[c.id] && (
                <Loader2 size={11} className="shrink-0 animate-spin text-brand" aria-label="Generating" />
              )}
              <span className="truncate">{c.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function SideNav() {
  const navigate = useNavigate();
  const collapsed = useUI((s) => s.navCollapsed);
  const toggle = useUI((s) => s.toggleNav);
  const openSearch = useUI((s) => s.openSearch);
  const [projectOpen, setProjectOpen] = useState(false);

  const newChat = () => {
    navigate('/chat');
    window.dispatchEvent(new CustomEvent('feral:new-chat'));
  };

  return (
    <>
      <motion.nav
        aria-label="Main"
        animate={{ width: collapsed ? NAV_COLLAPSED_W : NAV_W }}
        transition={{ duration: 0.22, ease: 'easeInOut' }}
        className={cn(
          'fixed left-3 top-3 bottom-3 z-30 flex flex-col overflow-hidden',
          // Lifted, not sunken. A panel a shade DARKER than the page reads as a
          // hole and its rounded corners vanish with it — which is what the
          // first two attempts here looked like. Theme tokens rather than
          // hand-rolled rgba, so light mode gets the same treatment for free.
          'rounded-2xl border border-border-default bg-bg-elevated/80 backdrop-blur-xl shadow-xl',
        )}
      >
        <div className="h-12 px-3 flex items-center justify-between shrink-0">
          {!collapsed && (
            <span className="font-semibold text-sm text-text-primary tracking-wide select-none">
              FERAL
            </span>
          )}
          <button
            type="button"
            onClick={toggle}
            aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            className={cn(
              'p-1.5 rounded-lg text-text-muted hover:bg-bg-hover hover:text-text-secondary cursor-pointer',
              collapsed && 'mx-auto',
            )}
          >
            {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
          </button>
        </div>

        <div className="px-2 space-y-0.5 shrink-0">
          {/* One creation door with two things behind it, rather than two rows
              that are only ever used one at a time. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                title={collapsed ? 'New' : undefined}
                className={cn(
                  'w-full flex items-center gap-3 h-9 px-3 rounded-xl text-sm cursor-pointer',
                  'text-text-primary bg-bg-elevated hover:bg-bg-hover transition-colors',
                  collapsed && 'justify-center px-0',
                )}
              >
                <Plus size={16} className="shrink-0" />
                {!collapsed && <span>New</span>}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              <DropdownMenuItem onSelect={newChat} className="gap-2">
                <MessageSquare size={14} />
                New chat
                <span className="ml-auto text-[11px] text-text-muted">⌘N</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setProjectOpen(true)} className="gap-2">
                <FolderPlus size={14} />
                New project
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Row icon={Search} label="Search" collapsed={collapsed} onClick={() => openSearch()} />
          {NAV.map((n) => (
            <Row key={n.to} icon={n.icon} label={n.label} collapsed={collapsed} to={n.to} />
          ))}
        </div>

        <div className="flex-1 min-h-0 px-2">
          <Recent collapsed={collapsed} />
        </div>

        <div className="px-2 pb-2 shrink-0">
          <Row icon={Settings} label="Settings" collapsed={collapsed} to="/settings" />
        </div>
      </motion.nav>

      <NewProjectDialog open={projectOpen} onOpenChange={setProjectOpen} />
    </>
  );
}
