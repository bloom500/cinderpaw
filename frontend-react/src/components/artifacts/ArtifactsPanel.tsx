import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, Check, Download, FileBox, FileUp, Loader2, MessageSquare, Pencil, Trash2, X } from 'lucide-react';
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
import { useArtifacts, type ArtifactRow } from '@/stores/artifacts';
import { cn, readLocal, writeLocal } from '@/lib/utils';

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
export function ArtifactsPanel({
  onClose,
  onAsk,
}: {
  onClose: () => void;
  /** Put a question about this artifact into the chat input. */
  onAsk?: (row: ArtifactRow) => void;
}) {
  const {
    rows, loaded, open, busy, error, lastExport, refresh, close, exportArtifact, deleteArtifact,
    editing, startEdit, cancelEdit, save, importPdf,
  } = useArtifacts();
  const pickRef = useRef<HTMLInputElement>(null);
  // Only the newest version is editable; an older one is restored instead.
  const canEdit = !!open && EDITABLE_KINDS.has(open.row.kind) && open.showing === open.row.version;

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
  const drag = useRef<{ x: number; w: number } | null>(null);
  const resizeTo = (w: number) => setWidth(clampWidth(w, rowWidth()));

  return (
    // Width + opacity animate on mount/unmount (AnimatePresence in ChatPage
    // drives the unmount half). overflow-hidden so the header/list don't wrap
    // and flash mid-slide while the width is still growing.
    <motion.aside
      ref={asideRef}
      initial={{ width: 0, opacity: 0 }}
      animate={{ width, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      // No easing while dragging: the edge has to stay under the pointer.
      transition={dragging ? { duration: 0 } : { duration: 0.22, ease: 'easeInOut' }}
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
      <ArtifactHeader className="px-3 pb-2.5 pt-6">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {open && !editing ? (
            <ArtifactAction tooltip="Back to the list" icon={ArrowLeft} onClick={close} />
          ) : open ? null : (
            <FileBox className="size-4 shrink-0 text-warning" />
          )}
          <div className="min-w-0 flex-1">
            <ArtifactTitle className="truncate">{open ? open.row.title : 'Artifacts'}</ArtifactTitle>
            {/* What it is and how fresh, where the eye already is. The list rows
                say the same for each item; the header says it for the one open. */}
            {(open || rows.length > 0) && (
              <ArtifactDescription className="truncate text-2xs">
                {open
                  ? `${open.row.kind} · v${open.row.version} · updated ${when(open.row.updatedAt)}`
                  : `${rows.length} saved`}
              </ArtifactDescription>
            )}
          </div>
        </div>
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
            // Any PDF, not only ones Cinderpaw made: filling and signing a form
            // someone sent you is the reason most people open a PDF editor.
            <>
              <ArtifactAction tooltip="Open a PDF" icon={FileUp} disabled={busy} onClick={() => pickRef.current?.click()} />
              <input
                ref={pickRef}
                type="file"
                accept="application/pdf,.pdf"
                className="hidden"
                aria-label="PDF file"
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
              onClick={() => void deleteArtifact(open.row.id)}
            />
          )}
          <ArtifactClose onClick={onClose} aria-label="Close artifacts" />
        </ArtifactActions>
      </ArtifactHeader>

      {error && (
        <p className="border-b border-border-subtle px-3 py-2 text-2xs text-(--warning)">{error}</p>
      )}

      {open ? (
        <Viewer />
      ) : (
        <List rows={rows} loaded={loaded} busy={busy} lastExport={lastExport} />
      )}
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
  const openArtifact = useArtifacts((s) => s.openArtifact);

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

  if (rows.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <FileBox size={20} className="text-text-muted" />
        <p className="text-xs text-text-muted">
          Nothing here yet. Ask Cinderpaw to write something up, or make you a chart, and it
          lands here instead of scrolling away.
        </p>
      </div>
    );
  }

  return (
    <>
      {lastExport && (
        <SavedLine saved={lastExport} />
      )}
      <ScrollArea className="flex-1">
        <ul className="flex flex-col gap-1 p-2">
          {rows.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                disabled={busy}
                onClick={() => void openArtifact(r.id)}
                className={cn(
                  'w-full rounded-lg border border-transparent px-2.5 py-2 text-left',
                  'hover:border-border-subtle hover:bg-bg-hover disabled:opacity-60',
                )}
              >
                <p className="truncate text-xs font-medium text-text-primary" title={r.title}>
                  {r.title}
                </p>
                <p className="truncate text-2xs text-text-muted">
                  {r.kind}
                  {r.version > 1 ? ` · v${r.version}` : ''} · {when(r.updatedAt)}
                </p>
              </button>
            </li>
          ))}
        </ul>
      </ScrollArea>
    </>
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
  if (kind === 'app' || kind === 'html' || kind === 'document') {
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
 * `live-frame` on <html> switches the window glass to its no-displacement form
 * (see globals.css). A counter, not a boolean, so two frames closing in either
 * order never leave the class set or clear it early.
 */
let liveFrames = 0;
function LiveFrame({ title, content }: { title: string; content: string }) {
  useEffect(() => {
    liveFrames += 1;
    document.documentElement.classList.add('live-frame');
    return () => {
      liveFrames -= 1;
      if (liveFrames === 0) document.documentElement.classList.remove('live-frame');
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

/** Relative when it is recent, because "2 minutes ago" is what the eye wants. */
function when(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(ms).toLocaleDateString();
}
