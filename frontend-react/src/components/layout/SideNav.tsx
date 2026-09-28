import { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { panelMotionEnd, panelMotionStart } from '@/lib/panelMotion';
import {
  Plus, Search, Folder, Box, Settings, FileBox, Globe,
  PanelLeftOpen, Loader2, FolderPlus, Star,
  ChevronDown, ChevronLeft, ChevronRight,
} from 'lucide-react';
import logoUrl from '@/assets/logo.svg';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { NewProjectDialog } from '@/components/items/NewProjectDialog';
import { useUI } from '@/stores/ui';
import { useConversations, type ConversationSummary } from '@/stores/conversations';
import { groupByRecency, type DatedGroup } from '@/lib/chatGroups';
import { ConversationActions, ProjectActions } from '@/components/items/ItemActions';
import { useProjects } from '@/stores/projects';
import { useArtifacts } from '@/stores/artifacts';
import { useBrowser } from '@/stores/browser';
import { cn } from '@/lib/utils';
import { Kbd, MOD } from '@/components/ui/kbd';
import { useMagnetic } from '@/hooks/useMagnetic';
import { APP_NAME } from '@/lib/brand';

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

export const NAV_W = 256;

/** Section headings in the library: STARRED, PROJECTS, TODAY, ... (canvas: 0.08em tracking; 12px, the scale's step nearest its 11.5). */
const LABEL = 'px-3 pb-1.5 pt-3.5 text-2xs font-semibold uppercase tracking-[0.08em] text-text-disabled select-none';
/** Hover on the sidebar ground. `bg-hover` is the sidebar's own colour in light, so it would not show. */
const ROW_HOVER = 'hover:bg-text-primary/5';
/**
 * Collapsed means gone, not narrow.
 *
 * An icon-only rail is the worst of both: it still costs width, and a column of
 * unlabelled glyphs is a quiz. If someone asks for the navigation to go away,
 * the honest answer is that it goes away — and one button, in the corner it
 * left from, brings it back.
 */
export const NAV_COLLAPSED_W = 0;

/**
 * Primary navigation is now only what the library below cannot be.
 *
 * "Chats" and "Projects" used to sit here as destinations. They were rows that
 * led to a page listing the same things this rail already lists — and now that
 * every row carries its own rename and delete, the page has nothing the rail
 * does not. Two doors to one room, where the near one is already open.
 */
const NAV = [
  { to: '/models',   icon: Box,           label: 'Models' },
  { to: '/settings', icon: Settings,      label: 'Settings' },
] as const;

function Row({
  icon: Icon, label, collapsed, onClick, to, active, hint,
}: {
  icon: React.ComponentType<{ size?: number | string; strokeWidth?: number; className?: string }>;
  label: string;
  collapsed: boolean;
  onClick?: () => void;
  to?: string;
  active?: boolean;
  /** Shown at the end of the row while expanded, e.g. its keyboard shortcut. */
  hint?: React.ReactNode;
}) {
  // Only while the rail is collapsed, and that is the whole justification.
  // Collapsed it IS a dock: icons in a column with nothing else to aim at, and
  // the lean tells you which one the pointer has before you get there.
  // Expanded these are labelled rows in a list, and a list whose rows move
  // under the cursor is a list that is harder to click.
  const magnet = useMagnetic<HTMLSpanElement>({ enabled: collapsed, radius: 72, pull: 5 });

  const inner = (
    <>
      <motion.span
        ref={magnet.ref}
        style={{ x: magnet.x, y: magnet.y }}
        className="flex shrink-0 items-center justify-center"
      >
        <Icon size={16} strokeWidth={1.75} className="shrink-0 text-text-muted" />
      </motion.span>
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
      {!collapsed && hint}
    </>
  );
  const classes = (isActive: boolean) => cn(
    'w-full flex items-center gap-3 h-9 px-3 rounded-[10px] text-sm text-text-primary transition-colors cursor-pointer',
    collapsed && 'justify-center px-0',
    isActive ? 'bg-bg-active' : ROW_HOVER,
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
 * Everything you have, in one scrolling column: projects first, then chats.
 *
 * Flat on purpose. Projects do not expand into their chats here — opening one
 * goes to the Projects page, where the contents have room to be read. A tree in
 * a 216px column is how the component this replaces reached 746 lines.
 *
 * The list is not capped. That is a deliberate reversal of the five-item cap
 * this file shipped with: browsing your own history should not require knowing
 * what you are looking for, and a person with two hundred chats scrolls a
 * column the same way they scroll every other app they use.
 */
function Library({ collapsed }: { collapsed: boolean }) {
  const navigate = useNavigate();
  const list = useConversations((s) => s.list);
  const loaded = useConversations((s) => s.loaded);
  const currentId = useConversations((s) => s.currentId);
  const streamingIds = useConversations((s) => s.streamingIds);
  const projects = useProjects((s) => s.list);
  // Drag-and-drop: a chat row dragged onto a project row moves it there.
  // `draggingChat` drives the rail-wide affordances while a drag is alive;
  // `dragOverProject` highlights the row under the cursor.
  const [draggingChat, setDraggingChat] = useState<string | null>(null);
  const [dragOverProject, setDragOverProject] = useState<string | null>(null);
  // Project accordion: clicking a project expands ITS chats in place,
  // grouped by date — a dropdown inside the rail, not a page and not a
  // view swap. One project open at a time keeps the column calm.
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null);
  // The projects store is refreshed by Chat/Projects pages; the rail must
  // not depend on having visited them first.
  useEffect(() => {
    void useProjects.getState().refresh();
  }, []);
  const starredIds = useUI((s) => s.starredChats);
  // Stars of chats deleted on an earlier launch are dropped at the first list
  // that was really read, and only then: delete-with-undo takes a chat out of
  // the list for a few seconds, and Undo must bring its star back with it.
  // An empty list is skipped because a failed read also ends with `loaded` and [].
  useEffect(() => {
    if (loaded && list.length > 0) useUI.getState().pruneStarred(list.map((c) => c.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);
  if (collapsed) return null;

  // A starred chat lives in STARRED only, not twice in the column.
  const byId = new Map((list ?? []).map((c) => [c.id, c]));
  const starred = starredIds.flatMap((id) => byId.get(id) ?? []);
  const groups = groupByRecency((list ?? []).filter((c) => !starredIds.includes(c.id)), (c) => c.updated_at);
  const chatCount = (list ?? []).length;

  const rowBase = 'w-full flex items-center gap-2.5 h-8 px-3 rounded-[10px] text-sm text-left transition-colors cursor-pointer';

  // Chat rows are identical in the all-chats view and inside a project's
  // drill-down — one renderer, so behavior can never drift between them.
  const renderChatRows = (items: typeof list, withStar = false) => (
    <div className="space-y-0.5">
      {items.map((c) => (
        // The row is a container so the actions can sit beside the
        // button rather than inside it — a button inside a button is
        // invalid HTML, and the menu trigger stops working the moment
        // the browser reparents it.
        <div
          key={c.id}
          draggable
          onDragStart={(e) => {
            // 'text/plain' as fallback: some engines refuse custom
            // MIME types when deciding whether a drop is allowed.
            e.dataTransfer.setData('text/cinderpaw-chat-id', c.id);
            e.dataTransfer.setData('text/plain', c.id);
            e.dataTransfer.effectAllowed = 'copyMove';
            setDraggingChat(c.id);
          }}
          onDragEnd={() => {
            setDraggingChat(null);
            setDragOverProject(null);
          }}
          className={cn(
            'group flex items-center rounded-[10px] pr-1 transition-opacity duration-150',
            c.id === currentId ? 'bg-bg-active' : ROW_HOVER,
            // While any chat is dragged, the other rows step back
            // so the target section reads as the destination.
            draggingChat && draggingChat !== c.id && 'opacity-40',
          )}
        >
          <button
            type="button"
            onClick={() => { void useConversations.getState().open(c.id); navigate('/chat'); }}
            // Which chat you are in was said in background colour alone, so a
            // screen reader read a column of interchangeable titles.
            aria-current={c.id === currentId ? 'page' : undefined}
            className={cn(
              rowBase,
              'flex-1 min-w-0',
              c.id === currentId
                ? 'text-text-primary'
                : 'text-text-muted group-hover:text-text-secondary',
            )}
          >
            {/* A chat can be generating while you are looking at another one. */}
            {streamingIds[c.id] ? (
              <Loader2 size={12} className="shrink-0 animate-spin text-brand" aria-label="Generating" />
            ) : withStar && (
              <Star size={14} className="shrink-0 fill-current text-brand" aria-hidden />
            )}
            <span className="truncate">{c.title}</span>
          </button>
          <ConversationActions conv={c} side="right" align="start" />
        </div>
      ))}
    </div>
  );

  const renderGroupedChats = (grouped: DatedGroup<ConversationSummary>[]) => (
    <div>
      {grouped.map((group) => (
        <section key={group.id}>
          {/* Date headings, unlike a "Chats" heading, are not a word the
              navigation already says one row above — they are the only
              thing that makes a long column scannable instead of a wall. */}
          <div className={LABEL}>
            {group.label}
          </div>
          {renderChatRows(group.items)}
        </section>
      ))}
    </div>
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide pb-2">
      {starred.length > 0 && (
        <section>
          <div className={LABEL}>Starred</div>
          {renderChatRows(starred, true)}
        </section>
      )}
      {projects.length > 0 && (
        <div className="space-y-0.5">
          <div className={LABEL}>Projects</div>
          {projects.map((p) => {
            const expanded = expandedProjectId === p.id;
            const convs = (list ?? []).filter((c) => p.conversation_ids.includes(c.id));
            const pGroups = groupByRecency(convs, (c) => c.updated_at);
            return (
              <div key={p.id}>
                <div
                  className={cn(
                    'group flex items-center rounded-[10px] pr-1 transition-all duration-150',
                    ROW_HOVER,
                    // While a chat is being dragged, every project row advertises
                    // itself as a target (dashed outline); the row under the cursor
                    // lights up solid and lifts slightly.
                    draggingChat && 'outline-solid outline-1 outline-dashed outline-brand/40',
                    dragOverProject === p.id &&
                      'ring-1 ring-brand bg-bg-active scale-[1.02]',
                  )}
                  onDragEnter={(e) => {
                    e.preventDefault();
                    setDragOverProject(p.id);
                  }}
                  onDragOver={(e) => {
                    // preventDefault on dragover is what flips the browser's
                    // slashed-circle into a copy cursor; dropEffect must agree
                    // with the source's effectAllowed or Chromium shows it
                    // anyway.
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'copy';
                    setDragOverProject(p.id);
                  }}
                  onDragLeave={(e) => {
                    e.preventDefault();
                    setDragOverProject((id) => (id === p.id ? null : id));
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const convId =
                      e.dataTransfer.getData('text/cinderpaw-chat-id') ||
                      e.dataTransfer.getData('text/plain');
                    if (convId) {
                      void useProjects.getState().addChat(p.id, convId);
                    }
                    setDragOverProject(null);
                    setDraggingChat(null);
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setExpandedProjectId(expanded ? null : p.id)}
                    aria-expanded={expanded}
                    className={cn(rowBase, 'flex-1 min-w-0 text-text-muted group-hover:text-text-secondary')}
                  >
                    {expanded ? (
                      <ChevronDown size={12} className="shrink-0" aria-hidden />
                    ) : (
                      <ChevronRight size={12} className="shrink-0" aria-hidden />
                    )}
                    <Folder size={16} strokeWidth={1.75} className="shrink-0" aria-hidden />
                    <span className="truncate">{p.name}</span>
                  </button>
                  <ProjectActions project={p} side="right" align="start" />
                </div>
                {/* The accordion body: the project's chats, grouped by date,
                    indented under the row. Everything stays in the rail. */}
                {expanded && (
                  <div className="ml-5 pl-2 border-l border-border-subtle space-y-3 my-1">
                    {convs.length === 0 ? (
                      <span className="block px-2 py-1 text-2xs text-text-disabled">
                        No chats yet. Drag one onto the project.
                      </span>
                    ) : (
                      renderGroupedChats(pGroups)
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!loaded ? (
        // "Empty" and "not read yet" are the same value in the store, so the
        // rail must not answer with the fresh-install sentence before it knows.
        <div className="space-y-1.5 px-3 pt-3.5" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-3 rounded bg-text-primary/10 animate-pulse"
              style={{ width: `${62 + ((i * 41) % 30)}%` }}
            />
          ))}
        </div>
      ) : chatCount === 0 ? (
        <span className="block px-3 pt-3.5 text-sm text-text-disabled">
          Your chats will appear here
        </span>
      ) : (
        renderGroupedChats(groups)
      )}
    </div>
  );
}

export function SideNav() {
  const navigate = useNavigate();
  const collapsed = useUI((s) => s.navCollapsed);
  const toggle = useUI((s) => s.toggleNav);
  const openSearch = useUI((s) => s.openSearch);
  const { pathname } = useLocation();
  const panelOpen = useArtifacts((s) => s.panelOpen);
  // The panel lives on the chat page, so from Models or Settings the row
  // goes there and opens it, rather than toggling something off screen.
  const openArtifacts = () => {
    useBrowser.getState().setPanel(false);
    // On the Context tab, the row switches to Artifacts rather than closing.
    const st = useArtifacts.getState();
    if (pathname === '/chat' && st.panelOpen && st.panelTab === 'artifacts') { st.togglePanel(); return; }
    useArtifacts.setState({ panelOpen: true, panelTab: 'artifacts' });
    if (pathname === '/chat') return;
    navigate('/chat');
  };
  const browserOpen = useBrowser((s) => s.panelOpen);
  // Same shape as Artifacts: it lives beside the chat, so from elsewhere the
  // row goes there. The two panels do not share the space.
  const openBrowser = () => {
    const next = pathname === '/chat' ? !browserOpen : true;
    useBrowser.getState().setPanel(next);
    if (next) useArtifacts.setState({ panelOpen: false });
    if (pathname !== '/chat') navigate('/chat');
  };
  const [projectOpen, setProjectOpen] = useState(false);

  const newChat = () => {
    useConversations.getState().newChat();
    navigate('/chat');
  };

  // Gone entirely, with one way back — but GONE ANIMATED. The collapse used
  // to early-return here, unmounting the rail between one frame and the next;
  // the "close" was a cut and the "open" slid out of nowhere. AnimatePresence
  // owns both directions now: the rail shrinks and fades as one motion, and
  // the expand button waits for it to be nearly gone before it fades in.
  //
  // The fixed-width inner wrapper is what keeps the shrink clean: without it,
  // the rail's children reflow at every width between NAV_W and 0 and the labels
  // wrap into jittering towers mid-animation.
  return (
    <>
      <AnimatePresence initial={false}>
        {collapsed && (
          <motion.button
            key="sidenav-expand"
            type="button"
            onClick={toggle}
            aria-label="Expand navigation"
            title="Expand navigation"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1, transition: { delay: 0.16, duration: 0.12 } }}
            exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.08 } }}
            className="fixed left-3 top-3 z-30 h-9 w-9 grid place-items-center rounded-lg border border-border-subtle bg-bg-elevated/80 backdrop-blur-sm text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer shadow-md"
          >
            <PanelLeftOpen size={20} />
          </motion.button>
        )}
      </AnimatePresence>
      {/* Always mounted: it only slides. Mounting it on every open rendered the
          whole uncapped chat list and refreshed projects in the frame the slide
          started, which was the stutter on open and not on close (17 Sep). */}
          <motion.nav
            key="sidenav"
            aria-label="Main"
            // Slides on transform at its full width, rather than growing its
            // width from 0: a width animation laid the page out again on every
            // frame, over glass that re-ran its displacement filter each time,
            // which was the stutter on open and close (17 Sep). The glass drops
            // its displacement for the length of the slide (panelMotion).
            style={{ width: NAV_W }}
            initial={false}
            animate={collapsed ? { x: -(NAV_W + 12), opacity: 0 } : { x: 0, opacity: 1 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            onAnimationStart={panelMotionStart}
            onAnimationComplete={panelMotionEnd}
            // Off screen is not gone for a keyboard or a screen reader; inert is.
            inert={collapsed}
            aria-hidden={collapsed}
          // The canvas's sidebar: a full-height column flush to the window's
          // left edge, on its own ground (`side`) with one hairline on the right.
          // It used to float as a rounded glass card; flush has no corners to
          // lose, so a shade darker than the page reads as a column, not a hole.
          className="fixed inset-y-0 left-0 z-30 flex flex-col overflow-hidden border-r border-border-default bg-bg-side"
      >
        {/* Fixed-width stage: the rail animates its own width, but everything
            inside stays laid out at full width so nothing reflows mid-shrink.
            The stage itself unmounts the instant collapse flips — what slides
            shut is the empty frame, which is both cleaner to watch and keeps
            every word out of the tree the moment "gone" was asked for. */}
        {(
        <div style={{ width: NAV_W }} className="h-full flex flex-col overflow-hidden px-3 pt-[18px]">
        {/* The window has no title bar, and this column now covers the top-left
            of the app-wide drag band, so the header drags the window itself.
            Only elements carrying the attribute drag; the button stays a button. */}
        <div data-tauri-drag-region className="flex shrink-0 items-center gap-2.5 px-2 pb-4 pt-0.5">
          <img src={logoUrl} alt="" draggable={false} data-tauri-drag-region className="size-8 shrink-0" />
          <span data-tauri-drag-region className="flex-1 select-none font-display text-2xl tracking-[-0.01em] text-text-primary">
            {APP_NAME}
          </span>
          <button
            type="button"
            onClick={toggle}
            aria-label="Collapse navigation"
            title="Collapse navigation"
            className={cn('grid size-[30px] shrink-0 place-items-center rounded-lg border border-border-default text-text-muted hover:text-text-primary transition-colors cursor-pointer', ROW_HOVER)}
          >
            <ChevronLeft size={16} strokeWidth={1.75} />
          </button>
        </div>

        {/* New chat is one click, as the canvas draws it. "New project" was the
            other half of the old New menu and keeps a door here, behind the
            chevron: on a fresh install there is no PROJECTS heading to hang it on. */}
        <div className="flex h-10 shrink-0 items-center rounded-xl bg-bg-active text-brand">
          <button
            type="button"
            onClick={newChat}
            className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2.5 pl-3 pr-1 text-left text-sm font-semibold"
          >
            <span aria-hidden className="grid size-5 shrink-0 place-items-center rounded-full bg-brand text-brand-foreground">
              <Plus size={12} strokeWidth={2.5} />
            </span>
            <span className="flex-1 truncate">New chat</span>
            <Kbd keys={[MOD, 'N']} />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="More to create"
                title="More to create"
                className={cn('grid h-full w-8 shrink-0 cursor-pointer place-items-center rounded-r-xl', ROW_HOVER)}
              >
                <ChevronDown size={14} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onSelect={() => setProjectOpen(true)} className="gap-2">
                <FolderPlus size={14} />
                New project
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="mt-2 space-y-0.5 shrink-0">
          <Row icon={Search} label="Search" collapsed={false} onClick={() => openSearch()} hint={<Kbd keys={[MOD, 'K']} />} />
          {/* The artifacts' entrance. It sat in the chat header first, right
              under the window's maximize button, where a miss resizes the window.
              Named Artifacts, not Workspace: the agent's scratch folder is already
              called workspace, and one word for two places confused the agent. */}
          <Row icon={FileBox} label="Artifacts" collapsed={false} onClick={openArtifacts} active={pathname === '/chat' && panelOpen && !browserOpen} />
          <Row icon={Globe} label="Browser" collapsed={false} onClick={openBrowser} active={pathname === '/chat' && browserOpen} />
          {NAV.map((n) => (
            <Row key={n.to} icon={n.icon} label={n.label} collapsed={false} to={n.to} />
          ))}
        </div>

        <div className="mx-2.5 mb-1 mt-3.5 h-px shrink-0 bg-border-default" aria-hidden />
        <div className="flex-1 min-h-0 flex flex-col">
          <Library collapsed={false} />
        </div>
        </div>
        )}
      </motion.nav>

      <NewProjectDialog open={projectOpen} onOpenChange={setProjectOpen} />
    </>
  );
}
