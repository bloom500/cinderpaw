import { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  MessageSquare, FolderPlus, Search, Box, Settings, Sparkles, Bot, Puzzle, Plug,
  PanelLeftClose, PanelLeftOpen, Lock, Folder,
  ChevronDown, ChevronRight, Loader2, Brain,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { ConversationActions, ProjectActions } from '@/components/items/ItemActions';
import { cn } from '@/lib/utils';
import { useUI } from '@/stores/ui';
import { useConversations, type ConversationSummary } from '@/stores/conversations';
import { useProjects, type Project } from '@/stores/projects';

export const SIDEBAR_W = 240;
export const SIDEBAR_COLLAPSED_W = 56;

type MenuAction = 'newChat' | 'newProject' | 'search' | 'models' | 'settings' | 'skills' | 'extensions' | 'connectors' | 'memoryLayers';

interface MenuItem {
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
  label: string;
  shortcut: string | null;
  action: MenuAction;
  disabled: boolean;
  route?: string;
}

const MENU: MenuItem[] = [
  { icon: MessageSquare, label: 'New Chat',    shortcut: '⌘N', action: 'newChat',    disabled: false, route: '/chat' },
  { icon: FolderPlus,   label: 'New Project',  shortcut: '⌘P', action: 'newProject', disabled: false },
  { icon: Search,       label: 'Search',       shortcut: '⌘K', action: 'search',     disabled: false },
  { icon: Box,          label: 'Models',       shortcut: null,  action: 'models',     disabled: false, route: '/models' },
  { icon: Settings,     label: 'Settings',     shortcut: null,  action: 'settings',   disabled: false, route: '/settings' },
  { icon: Sparkles,     label: 'Skills',       shortcut: null,  action: 'skills',     disabled: false },
  { icon: Puzzle,       label: 'Extensions',   shortcut: null,  action: 'extensions', disabled: false, route: '/extensions' },
  { icon: Plug,         label: 'Connectors',   shortcut: null,  action: 'connectors', disabled: false, route: '/connectors' },
  { icon: Brain,        label: 'Memory Layers', shortcut: null,  action: 'memoryLayers', disabled: false, route: '/memory-layers' },
];

// ── Sidebar root ───────────────────────────────────────────────────────────────

export function Sidebar() {
  const collapsed     = useUI((s) => s.sidebarCollapsed);
  const toggleSidebar = useUI((s) => s.toggleSidebar);
  const openSearch    = useUI((s) => s.openSearch);

  // Only creating a project lives here now. Renaming and deleting belong to the
  // item they act on, so they travel with it — see components/items/ItemActions.
  const [newProjectOpen, setNewProjectOpen]     = useState(false);
  const [projectNameDraft, setProjectNameDraft] = useState('');

  const handleMenuAction = (action: MenuAction) => {
    if (action === 'newProject') {
      setProjectNameDraft('');
      setNewProjectOpen(true);
    } else if (action === 'search') {
      openSearch();
    } else if (action === 'skills') {
      useUI.getState().openSkills();
    }
  };

  const handleCreateProject = async () => {
    const name = projectNameDraft.trim();
    if (!name) return;
    await useProjects.getState().create(name);
    setNewProjectOpen(false);
  };

  return (
    <TooltipProvider delayDuration={300}>
      <motion.aside
        animate={{ width: collapsed ? SIDEBAR_COLLAPSED_W : SIDEBAR_W }}
        transition={{ duration: 0.22, ease: 'easeInOut' }}
        className="fixed left-2 top-2 bottom-2 bg-bg-surface/90 backdrop-blur border border-border-subtle shadow-lg flex flex-col z-20 overflow-hidden rounded-2xl"
      >
        {/* Header */}
        <div className="h-12 px-3 flex items-center justify-between shrink-0">
          {!collapsed && (
            <span className="font-semibold text-text-primary text-sm select-none">Feral</span>
          )}
          <div className={cn('flex gap-1', collapsed && 'mx-auto')}>
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
            <MenuRow
              key={item.action}
              item={item}
              collapsed={collapsed}
              onAction={handleMenuAction}
            />
          ))}
        </nav>

        {/* Recent conversations + projects */}
        <div className="flex-1 overflow-y-auto px-2 pt-2 min-h-0 scrollbar-hide">
          <AnimatePresence>
            {!collapsed && <RecentSection />}
          </AnimatePresence>
        </div>
      </motion.aside>

      {/* New Project dialog */}
      <Dialog open={newProjectOpen} onOpenChange={setNewProjectOpen}>
        <DialogContent
          className="sm:max-w-sm"
          onOpenAutoFocus={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement | null)?.querySelector<HTMLInputElement>('input')?.focus(); }}
        >
          <DialogHeader>
            <DialogTitle>New Project</DialogTitle>
          </DialogHeader>
          <input
            value={projectNameDraft}
            onChange={(e) => setProjectNameDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleCreateProject(); }}
            placeholder="Project name"
            className="w-full rounded-md border border-bg-hover bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:ring-1 focus:ring-brand placeholder:text-text-muted"
          />
          <DialogFooter>
            <button
              onClick={() => setNewProjectOpen(false)}
              className="px-3 py-1.5 text-sm rounded text-text-muted hover:bg-bg-hover"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleCreateProject()}
              disabled={!projectNameDraft.trim()}
              className="px-3 py-1.5 text-sm rounded bg-brand text-white disabled:opacity-40"
            >
              Create
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}

// ── MenuRow ────────────────────────────────────────────────────────────────────

function MenuRow({
  item, collapsed, onAction,
}: {
  item: MenuItem;
  collapsed: boolean;
  onAction: (action: MenuAction) => void;
}) {
  const navigate = useNavigate();
  const Icon = item.icon;

  const onClick = () => {
    if (item.disabled) return;
    if (item.action === 'newChat') {
      navigate('/chat');
      window.dispatchEvent(new CustomEvent('feral:new-chat'));
      return;
    }
    if (item.action === 'newProject' || item.action === 'search' || item.action === 'skills') {
      onAction(item.action);
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

// ── RecentSection ──────────────────────────────────────────────────────────────

function RecentSection() {
  const list         = useConversations((s) => s.list);
  const currentId    = useConversations((s) => s.currentId);
  const streamingIds = useConversations((s) => s.streamingIds);
  const projects     = useProjects((s) => s.list);

  const projectedIds = new Set(projects.flatMap((p) => p.conversation_ids));
  const flatList     = (list ?? []).filter((c) => !projectedIds.has(c.id));
  const isStreaming  = (id: string) => Boolean(streamingIds[id]);

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
      </div>

      {projects.map((project) => (
        <ProjectRow
          key={project.id}
          project={project}
          allConvs={list ?? []}
          currentId={currentId}
          isStreaming={isStreaming}
        />
      ))}

      <div className="space-y-0.5 mt-1">
        {flatList.length === 0 && projects.length === 0 && (
          <div className="px-2 py-1 text-xs text-text-disabled">No conversations yet</div>
        )}
        {flatList.map((c) => (
          <RecentRow
            key={c.id}
            conv={c}
            currentId={currentId}
            isStreaming={isStreaming(c.id)}
          />
        ))}
      </div>
    </motion.div>
  );
}

// ── ProjectRow ─────────────────────────────────────────────────────────────────

function ProjectRow({
  project, allConvs, currentId, isStreaming,
}: {
  project: Project;
  allConvs: ConversationSummary[];
  currentId: string | null;
  isStreaming: (id: string) => boolean;
}) {
  // Collapsed by default: a fresh app launch should show a tidy list of folder
  // headers, not every project pre-expanded. The user opens the ones they want.
  const [expanded, setExpanded] = useState(false);
  const convMap = useMemo(() => new Map(allConvs.map((c) => [c.id, c])), [allConvs]);
  const projectConvs = project.conversation_ids
    .map((id) => convMap.get(id))
    .filter(Boolean) as ConversationSummary[];

  return (
    <div className="mb-1">
      <div className="group flex items-center gap-1 px-1 py-1 rounded hover:bg-bg-hover">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1.5 flex-1 text-left text-sm text-text-secondary min-w-0"
        >
          {expanded
            ? <ChevronDown size={13} className="shrink-0 text-text-muted" />
            : <ChevronRight size={13} className="shrink-0 text-text-muted" />}
          <Folder size={13} className="shrink-0 text-text-muted" />
          <span className="truncate">{project.name}</span>
        </button>

        <ProjectActions project={project} className="p-0.5" />
      </div>

      {expanded && (
        <div className="pl-4 space-y-0.5">
          {projectConvs.length === 0 && (
            <div className="px-2 py-1 text-xs text-text-disabled">Empty project</div>
          )}
          {projectConvs.map((c) => (
            <RecentRow
              key={c.id}
              conv={c}
              currentId={currentId}
              isStreaming={isStreaming(c.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── RecentRow ──────────────────────────────────────────────────────────────────

function RecentRow({
  conv, currentId, isStreaming = false,
}: {
  conv: ConversationSummary;
  currentId: string | null;
  isStreaming?: boolean;
}) {
  const navigate = useNavigate();
  const isActive = conv.id === currentId;
  const isAgentConv = !!conv.agent_id;

  return (
    <div className={cn('group flex items-center rounded transition-colors', isActive ? 'bg-bg-active' : 'hover:bg-bg-hover')}>
      <button
        type="button"
        onClick={() => navigate(`/chat/${conv.id}`)}
        className={cn(
          'flex-1 text-left px-2 py-1.5 text-sm truncate flex items-center gap-2 min-w-0',
          isActive ? 'text-text-primary' : 'text-text-secondary',
        )}
        title={isStreaming ? 'Generating…' : conv.title}
      >
        {isStreaming ? (
          <Loader2
            size={12}
            className="shrink-0 text-brand animate-spin"
            aria-label="Generating"
          />
        ) : isAgentConv ? (
          <Bot
            size={12}
            className="shrink-0 text-text-muted"
            aria-label="Agent conversation"
          />
        ) : null}
        <span className="truncate">{conv.title}</span>
      </button>

      <ConversationActions conv={conv} className="mr-1" />
    </div>
  );
}
