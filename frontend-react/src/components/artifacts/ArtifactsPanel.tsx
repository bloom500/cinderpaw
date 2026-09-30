import { panelMotionEnd, panelMotionExit, panelMotionStart } from '@/lib/panelMotion';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Archive, ArchiveRestore, ArrowLeft, BookOpen, Check, Download, ExternalLink as OpenIcon, FileBox, FileUp, Loader2, MessageSquare, Pencil, Trash2, X, type LucideIcon } from 'lucide-react';
import {
  ArtifactAction,
  ArtifactActions,
  ArtifactClose,
  ArtifactDescription,
  ArtifactHeader,
  ArtifactTitle,
} from '@/components/ai-elements/artifact';
import { Markdown } from '@/lib/markdown';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SelectMenu } from '@/components/ui/select-menu';
import { APP_IFRAME_SANDBOX } from '@/lib/artifactSandbox';
// The editor is ~400 KB (128 KB gzipped) of ProseMirror that most sessions never open. Loaded on
// the first Edit or What changed, not with the app.
const DocumentEditor = lazy(() => import('./ArtifactEditor').then((m) => ({ default: m.DocumentEditor })));
const SourceEditor = lazy(() => import('./ArtifactEditor').then((m) => ({ default: m.SourceEditor })));
const ChangesView = lazy(() => import('./ArtifactEditor').then((m) => ({ default: m.ChangesView })));
const PdfEditor = lazy(() => import('./PdfEditor').then((m) => ({ default: m.PdfEditor })));

function Loading() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <Loader2 size={16} className="animate-spin text-text-muted" />
    </div>
  );
}
import { useArtifacts, googlePlan, type ArtifactRow } from '@/stores/artifacts';
import { ContextTab } from './ContextTab';
import { artifactKind, artifactSize } from '@/components/chat/ArtifactCard';
import { chatContext } from '@/lib/chatContext';
import { useChat } from '@/stores/chat';
import { ExternalLink } from '@/components/chat/ExternalLink';
import { cn, readLocal, writeLocal } from '@/lib/utils';
import { tauri } from '@/lib/tauri';

const WIDTH_KEY = 'cinderpaw.artifactsPanelWidth';
const DEFAULT_WIDTH = 416;
const MIN_WIDTH = 320;
/** Must match the chat column's min-w-[28rem] in ChatPage. */
const CHAT_MIN_WIDTH = 448;

/**
 * Never narrower than a readable column, never so wide the chat cannot be read.
 *
 * The limit is what the row the panel sits in has left after the chat's minimum,
 * not a share of the window: 70% of the window ignored the sidebar and left the
 * chat about 100px wide, one word per line (17 Sep, screenshot).
 */
function clampWidth(w: number, rowWidth: number): number {
  const max = Math.max(MIN_WIDTH, rowWidth - CHAT_MIN_WIDTH);
  return Math.min(max, Math.max(MIN_WIDTH, Math.round(w)));
}

/**
 * The workspace: where the work goes when the conversation scrolls away.
 *
 * Two screens in one panel, list and viewer, rather than a list here and a
 * document somewhere else. Opening a thing you made should not feel like
 * navigating; it should feel like turning it over.
 *
 * Nothing here is hand-built that already existed: the scroller, the buttons
 * and the version picker are the app's own primitives, so the panel inherits
 * their focus rings, their keyboard behaviour and their dark mode instead of
 * growing a second set that drifts.
 */
/** The panel's heading, as on the Context board: a tile, the title in the
 *  display face, and one quiet line under it. */
function PanelTitle({ icon: Icon, title, sub }: { icon: LucideIcon; title: string; sub?: string }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border-default bg-bg-elevated text-text-secondary">
        <Icon size={20} />
      </span>
      <div className="min-w-0">
        <h2 className="truncate font-display text-xl leading-tight text-text-primary">{title}</h2>
        {sub && <p className="truncate text-xs text-text-muted">{sub}</p>}
      </div>
    </div>
  );
}

export function ArtifactsPanel({
  onClose,
  onAsk,
  onCompose,
  onAttach,
}: {
  onClose: () => void;
  /** Put a question about this artifact into the chat input. */
  onAsk?: (row: ArtifactRow) => void;
  /** Context tab: fill the composer (Links and Memory "Add"). */
  onCompose?: (text: string) => void;
  /** Context tab: the composer's file picker (Files "Add"). */
  onAttach?: () => void;
}) {
  const {
    rows, loaded, open, busy, error, lastExport, refresh, close, exportArtifact, deleteArtifact,
    editing, startEdit, cancelEdit, save, importPdf, showingArchived, showArchived,
    google, sendToGoogle, panelTab: tab, setPanelTab: setTab,
  } = useArtifacts();
  // Delete is for good now, so the header's Delete asks first, in the panel.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  useEffect(() => setConfirmingDelete(false), [open?.row.id]);
  const pickRef = useRef<HTMLInputElement>(null);
  // Only the newest version is editable; an older one is restored instead.
  const canEdit = !!open && EDITABLE_KINDS.has(open.row.kind) && open.showing === open.row.version;
  // A build without Cinderpaw's Google registration (a fork, a local build, a
  // release whose CI secret is missing) gets no button, not one that only fails.
  const [googleRegistered, setGoogleRegistered] = useState(false);
  useEffect(() => {
    tauri.google.status().then((s) => setGoogleRegistered(s !== null), () => setGoogleRegistered(false));
  }, []);

  // The list is also kept current by `artifact` events, which arrive from every
  // surface. This is only the first read, for the case where the panel is
  // opened before anything has happened in this session.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const asideRef = useRef<HTMLElement>(null);
  // The row = chat column + this panel. Before the first layout there is no
  // row to measure, so the window stands in; the chat's CSS min-width still
  // protects it in that one frame, and on every window resize after.
  const rowWidth = () => asideRef.current?.parentElement?.clientWidth ?? window.innerWidth;
  const [width, setWidth] = useState(() => clampWidth(Number(readLocal(WIDTH_KEY)) || DEFAULT_WIDTH, window.innerWidth));
  const [dragging, setDragging] = useState(false);
  // The slide in and out both run over the glass; see panelMotion.
  const entered = useRef(false);
  useEffect(() => {
    panelMotionStart();
    return () => {
      if (!entered.current) panelMotionEnd();
      panelMotionExit();
    };
  }, []);
  const drag = useRef<{ x: number; w: number } | null>(null);
  const resizeTo = (w: number) => setWidth(clampWidth(w, rowWidth()));

  return (
    // The panel takes its width at once and slides in on transform + opacity.
    // It used to animate `width` from 0, which resized the chat column on every
    // frame: the whole transcript was laid out again about thirteen times per
    // open and per close, which is the 1-2 s of stutter reported on 17 Sep.
    // Transform and opacity are composited, so the chat reflows once.
    <motion.aside
      ref={asideRef}
      initial={{ x: 32, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 32, opacity: 0 }}
      style={{ width }}
      transition={{ duration: 0.16, ease: 'easeOut' }}
      onAnimationComplete={() => {
        if (!entered.current) {
          entered.current = true;
          panelMotionEnd();
        }
      }}
      className={cn(
        // shrink, not shrink-0: when the window narrows below a saved width, the
        // panel gives way down to its minimum rather than pushing the chat off.
        'relative flex min-w-[320px] shrink flex-col overflow-hidden border-l border-border-default bg-bg-surface',
        // The frame is another document: without this, crossing it mid-drag
        // hands the pointer to the page inside and the drag stops.
        dragging && '[&_iframe]:pointer-events-none select-none',
      )}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize artifacts panel"
        aria-valuenow={width}
        aria-valuemin={MIN_WIDTH}
        tabIndex={0}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, w: width };
          setDragging(true);
        }}
        onPointerMove={(e) => {
          if (drag.current) resizeTo(drag.current.w + drag.current.x - e.clientX);
        }}
        onPointerUp={() => {
          drag.current = null;
          setDragging(false);
          writeLocal(WIDTH_KEY, String(width));
        }}
        onKeyDown={(e) => {
          const step = e.key === 'ArrowLeft' ? 24 : e.key === 'ArrowRight' ? -24 : 0;
          if (!step) return;
          e.preventDefault();
          const next = clampWidth(width + step, rowWidth());
          setWidth(next);
          writeLocal(WIDTH_KEY, String(next));
        }}
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-brand/40 focus-visible:bg-brand/40 focus-visible:outline-hidden"
      />
      {/* pt-6: the window's own close/maximize/minimize sit fixed at the top-right
          of the whole app (32px tall), and this panel is the rightmost thing on
          screen. Without it the panel's close button sat almost on the window's. */}
      {/* flex-wrap: at the panel's narrowest (320px) six 32px actions left the
          title two characters ("Rap…", 20 Sep). Wrapped, the actions drop
          under the title instead of eating it; wide, nothing changes. */}
      {/* The tabs (spec 2, right panel). The Browser keeps its own panel for now. */}
      <div role="tablist" aria-label="Side panel" className="flex shrink-0 items-end gap-5 border-b border-border-subtle pl-4 pr-3 pt-6">
        {(['artifacts', 'context'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              'h-10 border-b-2 px-0.5 text-sm transition-colors',
              tab === t ? 'border-brand font-medium text-text-primary' : 'border-transparent text-text-muted hover:text-text-primary',
            )}
          >
            {t === 'artifacts' ? 'Artifacts' : 'Context'}
          </button>
        ))}
        <div className="flex-1" />
        <ArtifactClose onClick={onClose} aria-label="Close panel" className="mb-1.5" />
      </div>
      {tab === 'context' ? <>
        <div className="flex shrink-0 items-center px-4 py-4">
          <PanelTitle icon={BookOpen} title="Context" sub="Everything Cinderpaw can see and use." />
        </div>
        <ContextTab onCompose={onCompose} onAttach={onAttach} />
      </> : <>
      <ArtifactHeader className={cn('flex-wrap', open ? 'px-3 py-2.5' : 'px-4 py-4')}>
        {open ? (
          <div className="flex min-w-[10rem] flex-1 items-center gap-2">
            {!editing && <ArtifactAction tooltip="Back to the list" icon={ArrowLeft} onClick={close} />}
            <div className="min-w-0 flex-1">
              <ArtifactTitle className="truncate">{open.row.title}</ArtifactTitle>
              {/* What it is and how fresh, where the eye already is. The list rows
                  say the same for each item; the header says it for the one open. */}
              <ArtifactDescription className="truncate text-2xs">
                {`${open.row.kind} · v${open.row.version} · updated ${when(open.row.updatedAt)}`}
              </ArtifactDescription>
            </div>
          </div>
        ) : (
          <PanelTitle
            icon={showingArchived ? Archive : FileBox}
            title={showingArchived ? 'Archived' : 'Artifacts'}
            sub={rows.length > 0 ? `${rows.length} saved` : 'What Cinderpaw makes for you.'}
          />
        )}
        <ArtifactActions>
          {/* While editing, the header offers only the two ways out of it.
              Back, Export and Delete would each act on the saved version and
              leave the typing behind without saying so. */}
          {editing && (
            <ArtifactAction tooltip="Discard changes" icon={X} disabled={busy} onClick={cancelEdit} />
          )}
          {editing && (
            <ArtifactAction tooltip="Save" icon={Check} disabled={busy} onClick={() => void save()} />
          )}
          {!open && (
            <ArtifactAction
              tooltip={showingArchived ? 'Back to artifacts' : 'Archived'}
              icon={showingArchived ? ArrowLeft : Archive}
              aria-pressed={showingArchived}
              onClick={() => showArchived(!showingArchived)}
            />
          )}
          {!open && !showingArchived && (
            // Any PDF, not only ones Cinderpaw made: filling and signing a form
            // someone sent you is the reason most people open a PDF editor.
            <>
              <ArtifactAction tooltip="Open a PDF or Word file" icon={FileUp} disabled={busy} onClick={() => pickRef.current?.click()} />
              <input
                ref={pickRef}
                type="file"
                accept="application/pdf,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx"
                className="hidden"
                aria-label="PDF or Word file"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void importPdf(file);
                }}
              />
            </>
          )}
          {open && !editing && canEdit && (
            <ArtifactAction tooltip="Edit" icon={Pencil} disabled={busy} onClick={startEdit} />
          )}
          {open && !editing && googleRegistered && googlePlan(open.row.kind) && (
            <ArtifactAction
              tooltip="Send to Google Docs"
              disabled={busy || google?.busy === true}
              onClick={() => void sendToGoogle()}
              aria-label="Send to Google Docs"
            >
              <GoogleMark />
            </ArtifactAction>
          )}
          {open && !editing && onAsk && (
            <ArtifactAction tooltip="Ask Cinderpaw" icon={MessageSquare} onClick={() => onAsk(open.row)} />
          )}
          {open && !editing && (
            <ArtifactAction
              tooltip="Export" icon={Download} disabled={busy}
              onClick={() => void exportArtifact(open.row.id)}
            />
          )}
          {open && !editing && (
            <ArtifactAction
              tooltip="Delete" icon={Trash2} disabled={busy}
              onClick={() => setConfirmingDelete(true)}
            />
          )}
        </ArtifactActions>
      </ArtifactHeader>

      {error && (
        <p className="border-b border-border-subtle px-3 py-2 text-2xs text-(--warning)">{error}</p>
      )}
      {open && google && (
        <p className={cn('border-b border-border-subtle px-3 py-2 text-2xs', google.error ? 'text-(--warning)' : 'text-text-muted')}>
          {google.busy
            ? 'Sending to Google…'
            : google.error
              ? google.error
              : google.link
                ? <>{'In your Google Drive: '}<ExternalLink href={google.link}>open it</ExternalLink></>
                : null}
        </p>
      )}

      {open && confirmingDelete && (
        <ConfirmDelete
          title={open.row.title}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => {
            setConfirmingDelete(false);
            void deleteArtifact(open.row.id);
          }}
        />
      )}

      {open ? (
        <Viewer />
      ) : (
        <List rows={rows} loaded={loaded} busy={busy} lastExport={lastExport} />
      )}
      </>}
    </motion.aside>
  );
}

function List({
  rows, loaded, busy, lastExport,
}: {
  rows: ArtifactRow[];
  loaded: boolean;
  busy: boolean;
  lastExport: { path: string; note: string } | null;
}) {
  const showingArchived = useArtifacts((s) => s.showingArchived);
  const messages = useChat((s) => s.messages);
  const chatArtifactIds = useMemo(() => chatContext(messages).artifactIds, [messages]);

  // Three states, not two. Before the first read comes back, "nothing here yet"
  // is a sentence about a fresh install being shown to someone with a dozen —
  // the mistake the Projects and Chats pages each had to be taught out of.
  if (!loaded) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 size={16} className="animate-spin text-text-muted" />
      </div>
    );
  }

  if (rows.length === 0 && showingArchived) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <Archive size={20} className="text-text-muted" />
        <p className="text-xs text-text-muted">Nothing archived. Archive keeps work out of the list without deleting it.</p>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <FileBox size={20} className="text-text-muted" />
        {/* Spec 11, first run. */}
        <p className="text-xs text-text-muted">Things Cinderpaw makes for you land here.</p>
        <p className="text-xs text-text-disabled">Try: "Make me a one-page plan for this week."</p>
      </div>
    );
  }

  // The Artifact Dock (spec 7.5): this chat's artifacts first, as large
  // cards; everything else below, as rows. Archived ones are not docked.
  const docked = showingArchived ? [] : chatArtifactIds
    .map((id) => rows.find((r) => r.id === id))
    .filter((r): r is ArtifactRow => !!r);
  const rest = rows.filter((r) => !docked.includes(r));

  return (
    <>
      {lastExport && (
        <SavedLine saved={lastExport} />
      )}
      <ScrollArea className="flex-1">
        {docked.length > 0 && (
          <section aria-label="In this chat" className="flex flex-col gap-3 px-4 pb-1 pt-1">
            <h3 className="px-1 text-sm font-semibold text-text-primary">
              In this chat <span className="font-normal text-text-muted">{docked.length}</span>
            </h3>
            {docked.map((r) => <DockCard key={r.id} row={r} busy={busy} />)}
          </section>
        )}
        {docked.length > 0 && rest.length > 0 && (
          <h3 className="px-5 pt-5 text-sm font-semibold text-text-primary">Everything else</h3>
        )}
        <ul className="flex flex-col gap-1 px-3 py-2">
          {rest.map((r) => (
            <li key={r.id}>
              <RowItem row={r} busy={busy} archived={showingArchived} />
            </li>
          ))}
        </ul>
      </ScrollArea>
    </>
  );
}

/** One of this chat's artifacts in the Dock: large tile, title, type and size, Open, Export. */
function DockCard({ row, busy }: { row: ArtifactRow; busy: boolean }) {
  const openArtifact = useArtifacts((s) => s.openArtifact);
  const exportArtifact = useArtifacts((s) => s.exportArtifact);
  const Icon = artifactKind(row.kind).icon;
  // As on the Dock board: a large tile, the kind's icon beside the title and
  // "Document, 12 KB", then Open and Export. No thumbnail yet: the store can
  // only read an artifact by opening it (see the slice 5 note in the handoff).
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border-default bg-bg-elevated p-3 shadow-sm">
      <button
        type="button"
        disabled={busy}
        onClick={() => void openArtifact(row.id)}
        aria-label={`Open ${row.title}`}
        className="flex h-28 items-center justify-center rounded-xl border border-border-subtle bg-bg-active/60 text-brand disabled:opacity-60"
      >
        <Icon size={28} />
      </button>
      <div className="flex items-center gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand text-brand-foreground">
          <Icon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-text-primary" title={row.title}>{row.title}</p>
          <p className="truncate text-xs text-text-muted">{artifactSize(row.kind, row.bytes)}</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void openArtifact(row.id)}
          className="flex h-8 items-center gap-1.5 rounded-lg border border-border-default bg-bg-surface px-3 text-sm font-medium text-text-primary hover:bg-text-primary/5 disabled:opacity-60"
        >
          Open
          <OpenIcon size={14} />
        </button>
        <div className="flex-1" />
        <button
          type="button"
          disabled={busy}
          onClick={() => void exportArtifact(row.id)}
          aria-label={`Export ${row.title}`}
          title="Export"
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-border-default bg-bg-surface text-text-muted hover:bg-text-primary/5 hover:text-text-primary disabled:opacity-60"
        >
          <Download size={16} />
        </button>
      </div>
    </div>
  );
}

/**
 * One artifact in the list, with its three actions beside it.
 *
 * The actions appear on hover and on keyboard focus, so a list of twenty is not
 * sixty icons, and they are real buttons a keyboard reaches. Rename edits in
 * place. Delete asks in the row itself, because it is for good.
 */
function RowItem({ row, busy, archived }: { row: ArtifactRow; busy: boolean; archived: boolean }) {
  const openArtifact = useArtifacts((s) => s.openArtifact);
  const renameArtifact = useArtifacts((s) => s.renameArtifact);
  const archiveArtifact = useArtifacts((s) => s.archiveArtifact);
  const deleteArtifact = useArtifacts((s) => s.deleteArtifact);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(row.title);
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <ConfirmDelete
        title={row.title}
        compact
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          void deleteArtifact(row.id);
        }}
      />
    );
  }

  const finishRename = (save: boolean) => {
    setRenaming(false);
    if (save) void renameArtifact(row.id, draft);
    else setDraft(row.title);
  };

  return (
    <div className="group flex items-center gap-1 rounded-lg border border-transparent pr-1 hover:border-border-subtle hover:bg-bg-hover focus-within:bg-bg-hover">
      {renaming ? (
        <input
          autoFocus
          aria-label="New name"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') finishRename(true);
            if (e.key === 'Escape') finishRename(false);
          }}
          onBlur={() => finishRename(true)}
          className="mx-1.5 my-1.5 min-w-0 flex-1 rounded-md border border-border-default bg-transparent px-2 py-1 text-xs text-text-primary outline-hidden focus:border-brand"
        />
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => void openArtifact(row.id)}
          className="min-w-0 flex-1 px-2.5 py-2 text-left disabled:opacity-60"
        >
          <p className="truncate text-xs font-medium text-text-primary" title={row.title}>
            {row.title}
          </p>
          <p className="truncate text-2xs text-text-muted">
            {row.kind}
            {row.version > 1 ? ` · v${row.version}` : ''} · {when(row.updatedAt)}
          </p>
        </button>
      )}
      {!renaming && (
        <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {/* Plain buttons with a native tooltip, not ArtifactAction: that one
              mounts a Radix tooltip per button, and three per row across a long
              list was paid on every render of the panel. */}
          <RowButton
            label="Rename" icon={Pencil}
            onClick={() => {
              setDraft(row.title);
              setRenaming(true);
            }}
          />
          <RowButton
            label={archived ? 'Unarchive' : 'Archive'} icon={archived ? ArchiveRestore : Archive}
            onClick={() => void archiveArtifact(row.id, !archived)}
          />
          <RowButton label="Delete" icon={Trash2} onClick={() => setConfirming(true)} />
        </div>
      )}
    </div>
  );
}

function RowButton({ label, icon: Icon, onClick }: { label: string; icon: typeof Pencil; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-md text-text-muted hover:bg-bg-elevated hover:text-text-primary focus-visible:outline-1 focus-visible:outline-brand"
    >
      <Icon size={14} />
    </button>
  );
}

/** "Delete for good?" asked where the click happened, never in a browser dialog. */
function ConfirmDelete({
  title, compact, onCancel, onConfirm,
}: {
  title: string;
  compact?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      role="alertdialog"
      aria-label={`Delete ${title}`}
      className={cn(
        'flex items-center gap-2 border-border-subtle bg-bg-elevated/40 px-3 py-2',
        compact ? 'rounded-lg border' : 'border-b',
      )}
    >
      <p className="min-w-0 flex-1 truncate text-2xs text-text-primary">{`Delete "${title}" and all its versions for good?`}</p>
      <button
        type="button"
        autoFocus
        onClick={onCancel}
        className="rounded-md px-2 py-1 text-2xs text-text-muted hover:bg-bg-hover hover:text-text-primary"
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={onConfirm}
        className="rounded-md border border-error/40 px-2 py-1 text-2xs text-error hover:bg-error/10"
      >
        Delete
      </button>
    </div>
  );
}

/** Text the person can change. A pdf, an image or an uploaded file is not. */
const EDITABLE_KINDS = new Set(['document', 'markdown', 'app', 'table', 'code', 'json', 'html', 'pdf']);

function Viewer() {
  const {
    open, lastExport, showVersion, editing, setDraft, conflict, save, cancelEdit, busy,
    review, showChanges, hideChanges, restore, applyPdf,
  } = useArtifacts();
  if (!open) return null;
  const { row, content, showing, versions } = open;

  if (editing) {
    return (
      <>
        {conflict !== null && (
          // The one moment two editors meet. Nothing is decided for the person:
          // their text stays in the editor until they pick.
          <div className="flex flex-col gap-1.5 border-b border-border-subtle bg-bg-elevated/40 px-3 py-2">
            <p className="text-2xs text-text-primary">
              {`Cinderpaw saved v${conflict} while you were editing v${editing.base}.`}
            </p>
            <div className="flex gap-2">
              <button
                type="button" disabled={busy} onClick={cancelEdit}
                className="rounded-md px-2 py-1 text-2xs text-text-muted hover:bg-bg-hover hover:text-text-primary disabled:opacity-60"
              >
                {`Discard mine, show v${conflict}`}
              </button>
              <button
                type="button" disabled={busy} onClick={() => void save(true)}
                className="rounded-md border border-border-default px-2 py-1 text-2xs text-text-primary hover:bg-bg-hover disabled:opacity-60"
              >
                Save mine as newest
              </button>
            </div>
          </div>
        )}
        <Suspense fallback={<Loading />}>
          {row.kind === 'pdf' ? (
            <PdfEditor base64={content} fields={open.fields ?? []} editing busy={busy} onDraft={setDraft} />
          ) : row.kind === 'document' ? (
            <DocumentEditor value={editing.draft} onChange={setDraft} />
          ) : (
            <SourceEditor value={editing.draft} onChange={setDraft} />
          )}
        </Suspense>
      </>
    );
  }

  if (review && showing === row.version) {
    return (
      <Suspense fallback={<Loading />}>
      <ChangesView
        kind={row.kind}
        before={review.before}
        after={content}
        beforeVersion={review.beforeVersion}
        afterVersion={showing}
        busy={busy}
        onClose={hideChanges}
        onUndo={() => void restore(review.beforeVersion)}
      />
      </Suspense>
    );
  }

  return (
    <>
      {/* Ask, Export and Delete moved up into the header's actions. What stays
          here is the version picker, and only when there is a choice to make. */}
      {versions.length > 1 && (
        <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
          <SelectMenu
            ariaLabel="Version"
            value={String(showing)}
            options={versions.map((v) => ({
              value: String(v.version),
              // The author is the point: it is what makes a document the agent
              // wrote and a document the person edited one history rather than
              // two competing ones.
              label: `v${v.version} · ${v.author === 'user' ? 'you' : 'Cinderpaw'}`,
            }))}
            onChange={(v) => void showVersion(Number(v))}
            className="h-7 text-2xs"
          />
          {showing === row.version && showing > 1 && row.kind !== 'pdf' && (
            <button
              type="button"
              onClick={() => void showChanges()}
              className="ml-auto rounded-md px-2 py-1 text-2xs text-text-muted hover:bg-bg-hover hover:text-text-primary"
            >
              What changed
            </button>
          )}
          {showing !== row.version && (
            // Restoring is a new version, never a rewind, so this cannot lose
            // anything: the version it replaces stays in the list.
            <button
              type="button"
              disabled={busy}
              onClick={() => void restore(showing)}
              className="ml-auto rounded-md border border-border-default px-2 py-1 text-2xs text-text-primary hover:bg-bg-hover disabled:opacity-60"
            >
              {`Make v${showing} current`}
            </button>
          )}
        </div>
      )}

      {lastExport && (
        <SavedLine saved={lastExport} />
      )}

      {showing !== row.version && (
        // Said out loud, because an old version looks exactly like the current
        // one and editing from here would be editing the wrong thing.
        <p className="border-b border-border-subtle bg-bg-elevated/40 px-3 py-1.5 text-2xs text-text-muted">
          Showing v{showing}. The current version is v{row.version}.
        </p>
      )}

      {row.kind === 'pdf' ? (
        <Suspense fallback={<Loading />}>
          <PdfEditor
            base64={content}
            fields={open.fields ?? []}
            editing={false}
            busy={busy}
            // Turning or removing an old version's page would save on top of the
            // newest one; restore it first.
            {...(showing === row.version ? { onPageAction: (edit) => void applyPdf(edit) } : {})}
          />
        </Suspense>
      ) : (
        <Preview kind={row.kind} title={row.title} content={content} />
      )}
    </>
  );
}

/**
 * What the artifact looks like, by kind.
 *
 * `app` and `html` run in an iframe with `allow-scripts` and deliberately NOT
 * `allow-same-origin`. This webview can call `invoke()`, so model-authored HTML
 * with our own origin would be a stored-XSS primitive pointed at the Tauri
 * command surface — and the content can come from a page the agent read or a
 * file a stranger sent on one of 21 chat platforms. The two flags together are
 * documented as equivalent to removing the sandbox, which is why the value is a
 * shared constant rather than a string typed here.
 *
 * `srcdoc` rather than a URL: there is no origin to serve it from, and none is
 * wanted.
 */
function Preview({ kind, title, content }: { kind: string; title: string; content: string }) {
  // A Word file arrives as preview HTML built by the sidecar, and is framed
  // like any other HTML: it came from a stranger's file.
  if (kind === 'app' || kind === 'html' || kind === 'document' || kind === 'docx') {
    return <LiveFrame title={title} content={content} />;
  }
  if (kind === 'markdown') {
    return (
      <ScrollArea className="flex-1">
        <div className="px-3 py-3 text-xs">
          <Markdown>{content}</Markdown>
        </div>
      </ScrollArea>
    );
  }
  return (
    <ScrollArea className="flex-1">
      <pre className="whitespace-pre-wrap break-words px-3 py-3 text-2xs text-text-primary">
        {content}
      </pre>
    </ScrollArea>
  );
}

/**
 * The sandboxed frame, and the one thing it tells the page while it is mounted.
 *
 * `data-live-frame` on <html> is there for the window glass to switch to its
 * no-displacement form (see globals.css). A counter, not a boolean, so two
 * frames closing in either order never leave the mark set or clear it early.
 * An attribute rather than a class, for the reason in lib/panelMotion.ts: a
 * class change on <html> restyles the whole page.
 */
let liveFrames = 0;
function LiveFrame({ title, content }: { title: string; content: string }) {
  useEffect(() => {
    liveFrames += 1;
    document.documentElement.toggleAttribute('data-live-frame', true);
    return () => {
      liveFrames -= 1;
      if (liveFrames === 0) document.documentElement.toggleAttribute('data-live-frame', false);
    };
  }, []);
  return (
    <iframe
      title={title}
      srcDoc={content}
      sandbox={APP_IFRAME_SANDBOX}
      className="flex-1 border-0 bg-white"
    />
  );
}

/**
 * Where the file went, as ONE text node.
 *
 * Split across JSX children it renders as several nodes, which reads the same
 * on screen and is a different thing to a screen reader, to select-and-copy,
 * and to any test that looks for the sentence.
 */
function SavedLine({ saved }: { saved: { path: string; note: string } }) {
  return (
    <p className="border-b border-border-subtle px-3 py-2 text-2xs text-text-muted">
      {`Saved to ${saved.path}${saved.note ? ` ${saved.note}` : ''}`}
    </p>
  );
}

/** Google's four-colour "G", the mark its brand guidelines set for a sign-in button. */
function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" className="size-4" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/** Relative when it is recent, because "2 minutes ago" is what the eye wants. */
function when(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(ms).toLocaleDateString();
}
