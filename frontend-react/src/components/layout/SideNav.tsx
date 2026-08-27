import { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Plus, Search, MessageSquare, Folder, Box, Settings,
  PanelLeftClose, PanelLeftOpen, Loader2, FolderPlus,
  ChevronDown, ChevronRight,
} from 'lucide-react';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { NewProjectDialog } from '@/components/items/NewProjectDialog';
import { useUI } from '@/stores/ui';
import { useConversations, type ConversationSummary } from '@/stores/conversations';
import { groupByRecency, type DatedGroup } from '@/lib/chatGroups';
import { ConversationActions, ProjectActions } from '@/components/items/ItemActions';
import { useProjects } from '@/stores/projects';
import { cn } from '@/lib/utils';
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

export const NAV_W = 216;
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
    void useProjects.getState().refresh().catch(console.error);
  }, []);
  if (collapsed) return null;

  const groups = groupByRecency(list ?? [], (c) => c.updated_at);
  const chatCount = (list ?? []).length;

  const rowBase = 'w-full flex items-center gap-2 h-8 px-3 rounded-lg text-sm text-left transition-colors cursor-pointer';

  // Chat rows are identical in the all-chats view and inside a project's
  // drill-down — one renderer, so behavior can never drift between them.
  const renderChatRows = (items: typeof list) => (
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
            'group flex items-center rounded-lg pr-1 transition-opacity duration-150',
            c.id === currentId ? 'bg-bg-active' : 'hover:bg-bg-hover',
            // While any chat is dragged, the other rows step back
            // so the target section reads as the destination.
            draggingChat && draggingChat !== c.id && 'opacity-40',
          )}
        >
          <button
            type="button"
            onClick={() => { void useConversations.getState().open(c.id); navigate('/chat'); }}
            className={cn(
              rowBase,
              'flex-1 min-w-0',
              c.id === currentId
                ? 'text-text-primary'
                : 'text-text-muted group-hover:text-text-secondary',
            )}
          >
            {/* A chat can be generating while you are looking at another one. */}
            {streamingIds[c.id] && (
              <Loader2 size={11} className="shrink-0 animate-spin text-brand" aria-label="Generating" />
            )}
            <span className="truncate">{c.title}</span>
          </button>
          <ConversationActions conv={c} side="right" align="start" />
        </div>
      ))}
    </div>
  );

  const renderGroupedChats = (grouped: DatedGroup<ConversationSummary>[]) => (
    <div className="space-y-3">
      {grouped.map((group) => (
        <section key={group.id}>
          {/* Date headings, unlike a "Chats" heading, are not a word the
              navigation already says one row above — they are the only
              thing that makes a long column scannable instead of a wall. */}
          <div className="px-3 pb-1 pt-1 text-xs font-semibold uppercase tracking-wider text-text-secondary">
            {group.label}
          </div>
          {renderChatRows(group.items)}
        </section>
      ))}
    </div>
  );

  return (
    <div className="mt-4 min-h-0 flex-1 overflow-y-auto scrollbar-hide pb-2">
      {projects.length > 0 && (
        <div className="space-y-0.5 mb-3">
          {projects.map((p) => {
            const expanded = expandedProjectId === p.id;
            const convs = (list ?? []).filter((c) => p.conversation_ids.includes(c.id));
            const pGroups = groupByRecency(convs, (c) => c.updated_at);
            return (
              <div key={p.id}>
                <div
                  className={cn(
                    'group flex items-center rounded-lg pr-1 hover:bg-bg-hover transition-all duration-150',
                    // While a chat is being dragged, every project row advertises
                    // itself as a target (dashed outline); the row under the cursor
                    // lights up solid and lifts slightly.
                    draggingChat && 'outline outline-1 outline-dashed outline-brand/40',
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
                      void useProjects.getState().addChat(p.id, convId).catch(console.error);
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
                    <Folder size={13} className="shrink-0" aria-hidden />
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
                        No chats yet — drag one onto the project.
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
        <div className="space-y-1.5 px-3 py-1" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-3 rounded bg-bg-hover animate-pulse"
              style={{ width: `${62 + ((i * 41) % 30)}%` }}
            />
          ))}
        </div>
      ) : chatCount === 0 ? (
        <span className="block px-3 py-1 text-xs text-text-disabled">
          Nothing yet. Ask Cinderpaw something.
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
  const [projectOpen, setProjectOpen] = useState(false);

  const newChat = () => {
    navigate('/chat');
    window.dispatchEvent(new CustomEvent('cinderpaw:new-chat'));
  };

  // Gone entirely, with one way back — but GONE ANIMATED. The collapse used
  // to early-return here, unmounting the rail between one frame and the next;
  // the "close" was a cut and the "open" slid out of nowhere. AnimatePresence
  // owns both directions now: the rail shrinks and fades as one motion, and
  // the expand button waits for it to be nearly gone before it fades in.
  //
  // The fixed-width inner wrapper is what keeps the shrink clean: without it,
  // the rail's children reflow at every width between 216 and 0 and the labels
  // wrap into jittering towers mid-animation.
  return (
    <>
      <AnimatePresence initial={false}>
        {collapsed ? (
          <motion.button
            key="sidenav-expand"
            type="button"
            onClick={toggle}
            aria-label="Expand navigation"
            title="Expand navigation"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1, transition: { delay: 0.16, duration: 0.12 } }}
            exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.08 } }}
            className="fixed left-3 top-3 z-30 h-9 w-9 grid place-items-center rounded-lg border border-border-subtle bg-bg-elevated/80 backdrop-blur text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer shadow-md"
          >
            <PanelLeftOpen size={19} />
          </motion.button>
        ) : (
          <motion.nav
            key="sidenav"
            aria-label="Main"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: NAV_W, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: 'easeInOut' }}
          className={cn(
            'fixed left-3 top-3 bottom-3 z-30 flex flex-col overflow-hidden',
          // Lifted, not sunken. A panel a shade DARKER than the page reads as a
          // hole and its rounded corners vanish with it — which is what the
          // first two attempts here looked like. Theme tokens rather than
          // hand-rolled rgba, so light mode gets the same treatment for free.
          // The rail is a SECOND sheet lying on the first, so it uses the same
          // material as everything else rather than its own hand-rolled blur —
          // that is what stops the two panes looking like different substances.
          'rounded-2xl bg-bg-elevated',
          // The rim carries the border, the lit top edge and the left gleam —
          // the hairline this component used to hand-roll with `before:*`
          // utilities is part of the material now, so every glass surface has
          // it instead of just this one.
          'liquid-glass liquid-glass-rim',
        )}
      >
        {/* Fixed-width stage: the rail animates its own width, but everything
            inside stays laid out at full width so nothing reflows mid-shrink.
            The stage itself unmounts the instant collapse flips — what slides
            shut is the empty frame, which is both cleaner to watch and keeps
            every word out of the tree the moment "gone" was asked for. */}
        {!collapsed && (
        <div style={{ width: NAV_W }} className="h-full flex flex-col overflow-hidden">
        <div className="h-12 px-3 flex items-center justify-between shrink-0">
          {!collapsed && (
            <span className="font-semibold text-sm text-text-primary tracking-wide select-none">
              {APP_NAME.toUpperCase()}
            </span>
          )}
          <button
            type="button"
            onClick={toggle}
            aria-label="Collapse navigation"
            title="Collapse navigation"
            className="h-9 w-9 grid place-items-center rounded-lg text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
          >
            <PanelLeftClose size={19} />
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
                <span className="ml-auto text-2xs text-text-muted">⌘N</span>
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

        <div className="flex-1 min-h-0 px-2 flex flex-col">
          <Library collapsed={collapsed} />
        </div>
        </div>
        )}
      </motion.nav>
        )}
      </AnimatePresence>

      <NewProjectDialog open={projectOpen} onOpenChange={setProjectOpen} />
    </>
  );
}
