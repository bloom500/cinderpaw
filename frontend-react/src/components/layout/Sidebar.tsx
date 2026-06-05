import { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  MessageSquare, FolderPlus, Search, Box, Settings, Sparkles, Bot,
  Download, PanelLeftClose, PanelLeftOpen, Lock, Folder,
  ChevronDown, ChevronRight, MoreHorizontal, Trash2, FolderInput, FolderMinus,
  X, CheckCircle, AlertCircle, Loader2,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub,
  DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useUI } from '@/stores/ui';
import { useConversations, type ConversationSummary } from '@/stores/conversations';
import { useProjects, type Project } from '@/stores/projects';
import { useDownload } from '@/stores/download';

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
  { icon: MessageSquare, label: 'New Chat',    shortcut: '⌘N', action: 'newChat',    disabled: false, route: '/chat' },
  { icon: FolderPlus,   label: 'New Project',  shortcut: '⌘P', action: 'newProject', disabled: false },
  { icon: Search,       label: 'Search',       shortcut: '⌘K', action: 'search',     disabled: false },
  { icon: Box,          label: 'Models',       shortcut: null,  action: 'models',     disabled: false, route: '/models' },
  { icon: Settings,     label: 'Settings',     shortcut: null,  action: 'settings',   disabled: false, route: '/settings' },
  { icon: Sparkles,     label: 'Skills',       shortcut: null,  action: 'skills',     disabled: false },
];

// ── Download status popover ───────────────────────────────────────────────────

function DownloadButton() {
  const active   = useDownload((s) => s.active);
  const done     = useDownload((s) => s.done);
  const error    = useDownload((s) => s.error);
  const hasActivity = active !== null || done || error !== null;
  const progress = active ? Math.round(active.progress * 100) : 0;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="relative p-1.5 rounded hover:bg-bg-hover text-text-muted hover:text-text-secondary transition-colors"
          aria-label="Downloads"
        >
          <Download size={16} />
          {/* Active indicator dot */}
          {active && (
            <span className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-brand border border-bg-surface" />
          )}
          {done && !active && (
            <span className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-success border border-bg-surface" />
          )}
          {error && (
            <span className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-error border border-bg-surface" />
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={8}
        className="w-72 bg-bg-surface border border-border-subtle text-text-primary p-4"
      >
        <p className="text-xs font-semibold uppercase tracking-wider text-text-muted mb-3">
          Downloads
        </p>

        {!hasActivity && (
          <p className="text-sm text-text-muted text-center py-3">No active downloads</p>
        )}

        {/* Active download */}
        {active && (
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs font-medium text-text-primary truncate">{active.filename}</p>
                <p className="text-[11px] text-text-muted truncate">{active.repoId}</p>
              </div>
              <button
                type="button"
                onClick={() => void useDownload.getState().cancel()}
                className="shrink-0 p-0.5 rounded text-text-muted hover:text-error hover:bg-error/10 transition-colors"
                aria-label="Cancel download"
              >
                <X size={13} />
              </button>
            </div>
            <div className="space-y-1">
              <div className="flex justify-between text-[11px] text-text-muted">
                <span>Downloading…</span>
                <span>{progress}%</span>
              </div>
              <div className="h-1.5 rounded-full bg-bg-elevated overflow-hidden">
                <motion.div
                  className="h-full bg-brand rounded-full"
                  animate={{ width: `${progress}%` }}
                  transition={{ duration: 0.3 }}
                />
              </div>
            </div>
          </div>
        )}

        {/* Completed */}
        {done && !active && (
          <div className="flex items-center gap-2 text-success text-sm">
            <CheckCircle size={14} />
            <span>Download complete</span>
            <button
              type="button"
              onClick={() => useDownload.getState().reset()}
              className="ml-auto text-[11px] text-text-muted hover:text-text-secondary"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-error text-sm">
              <AlertCircle size={14} />
              <span>Download failed</span>
            </div>
            <p className="text-[11px] text-text-muted break-all">{error}</p>
            <button
              type="button"
              onClick={() => useDownload.getState().reset()}
              className="text-[11px] text-text-muted hover:text-text-secondary mt-1"
            >
              Dismiss
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ── Sidebar root ───────────────────────────────────────────────────────────────

export function Sidebar() {
  const collapsed     = useUI((s) => s.sidebarCollapsed);
  const toggleSidebar = useUI((s) => s.toggleSidebar);
  const openSearch    = useUI((s) => s.openSearch);

  const [newProjectOpen, setNewProjectOpen]     = useState(false);
  const [projectNameDraft, setProjectNameDraft] = useState('');
  const [renameTarget, setRenameTarget]         = useState<Project | null>(null);
  const [renameDraft, setRenameDraft]           = useState('');

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

  const handleRenameProject = async () => {
    const name = renameDraft.trim();
    if (!name || !renameTarget) return;
    await useProjects.getState().rename(renameTarget.id, name);
    setRenameTarget(null);
  };

  return (
    <TooltipProvider delayDuration={300}>
      <motion.aside
        animate={{ width: collapsed ? SIDEBAR_COLLAPSED_W : SIDEBAR_W }}
        transition={{ duration: 0.22, ease: 'easeInOut' }}
        className="fixed left-2 top-2 bottom-2 bg-bg-surface flex flex-col z-20 overflow-hidden rounded-2xl border border-border-subtle shadow-lg"
      >
        {/* Header */}
        <div className="h-12 px-3 flex items-center justify-between shrink-0">
          {!collapsed && (
            <span className="font-semibold text-text-primary text-sm select-none">Feral</span>
          )}
          <div className={cn('flex gap-1', collapsed && 'mx-auto')}>
            {!collapsed && <DownloadButton />}
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
            {!collapsed && (
              <RecentSection
                onRenameProject={(p) => {
                  setRenameDraft(p.name);
                  setRenameTarget(p);
                }}
              />
            )}
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
                v0.1.3
              </motion.span>
            )}
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

      {/* Rename Project dialog */}
      <Dialog open={!!renameTarget} onOpenChange={(open) => { if (!open) { setRenameTarget(null); setRenameDraft(''); } }}>
        <DialogContent
          className="sm:max-w-sm"
          onOpenAutoFocus={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement | null)?.querySelector<HTMLInputElement>('input')?.focus(); }}
        >
          <DialogHeader>
            <DialogTitle>Rename Project</DialogTitle>
          </DialogHeader>
          <input
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleRenameProject(); }}
            placeholder="Project name"
            className="w-full rounded-md border border-bg-hover bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:ring-1 focus:ring-brand placeholder:text-text-muted"
          />
          <DialogFooter>
            <button
              onClick={() => setRenameTarget(null)}
              className="px-3 py-1.5 text-sm rounded text-text-muted hover:bg-bg-hover"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleRenameProject()}
              disabled={!renameDraft.trim()}
              className="px-3 py-1.5 text-sm rounded bg-brand text-white disabled:opacity-40"
            >
              Save
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

function RecentSection({ onRenameProject }: { onRenameProject: (p: Project) => void }) {
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
          onRename={onRenameProject}
          projects={projects}
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
            projectId={null}
            projects={projects}
            isStreaming={isStreaming(c.id)}
          />
        ))}
      </div>
    </motion.div>
  );
}

// ── ProjectRow ─────────────────────────────────────────────────────────────────

function ProjectRow({
  project, allConvs, currentId, onRename, projects, isStreaming,
}: {
  project: Project;
  allConvs: ConversationSummary[];
  currentId: string | null;
  onRename: (p: Project) => void;
  projects: Project[];
  isStreaming: (id: string) => boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const convMap = useMemo(() => new Map(allConvs.map((c) => [c.id, c])), [allConvs]);
  const projectConvs = project.conversation_ids
    .map((id) => convMap.get(id))
    .filter(Boolean) as ConversationSummary[];

  const handleDelete = async () => {
    await useProjects.getState().delete(project.id);
  };

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

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Project options"
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-bg-hover text-text-muted hover:text-text-secondary shrink-0"
            >
              <MoreHorizontal size={14} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start">
            <DropdownMenuItem onClick={() => onRename(project)}>
              Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => void handleDelete().catch(console.error)}
              className="text-red-400 focus:text-red-400"
            >
              <Trash2 size={13} />
              Delete project
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
              projectId={project.id}
              projects={projects}
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
  conv, currentId, projectId, projects, isStreaming = false,
}: {
  conv: ConversationSummary;
  currentId: string | null;
  projectId: string | null;
  projects: Project[];
  isStreaming?: boolean;
}) {
  const navigate = useNavigate();
  const isActive = conv.id === currentId;
  const isAgentConv = !!conv.agent_id;

  const handleDelete = async () => {
    await useConversations.getState().delete(conv.id);
  };

  const handleAddToProject = async (pid: string) => {
    await useProjects.getState().addChat(pid, conv.id);
  };

  const handleRemoveFromProject = async () => {
    if (!projectId) return;
    await useProjects.getState().removeChat(projectId, conv.id);
  };

  return (
    <div className={cn('group flex items-center rounded transition-colors', isActive ? 'bg-bg-active' : 'hover:bg-bg-hover')}>
      <button
        type="button"
        onClick={() => navigate(`/chat/${conv.id}`)}
        className={cn(
          'flex-1 text-left px-2 py-1.5 text-sm truncate flex items-center gap-2 min-w-0',
          isActive ? 'text-text-primary' : 'text-text-secondary',
        )}
        title={isStreaming ? 'Generare în curs…' : conv.title}
      >
        {isStreaming ? (
          <Loader2
            size={12}
            className="shrink-0 text-brand animate-spin"
            aria-label="Generare în curs"
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

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Chat options"
            className="opacity-0 group-hover:opacity-100 p-1 mr-1 rounded hover:bg-bg-hover text-text-muted hover:text-text-secondary shrink-0"
          >
            <MoreHorizontal size={13} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start">
          {projectId ? (
            <DropdownMenuItem onClick={() => void handleRemoveFromProject().catch(console.error)}>
              <FolderMinus size={13} />
              Remove from project
            </DropdownMenuItem>
          ) : (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={projects.length === 0}>
                <FolderInput size={13} />
                {projects.length === 0 ? 'No projects yet' : 'Add to project'}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {projects.map((p) => (
                  <DropdownMenuItem key={p.id} onClick={() => void handleAddToProject(p.id).catch(console.error)}>
                    <Folder size={13} />
                    {p.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => void handleDelete().catch(console.error)}
            className="text-red-400 focus:text-red-400"
          >
            <Trash2 size={13} />
            Delete chat
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
