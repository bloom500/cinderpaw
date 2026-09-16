import { useEffect } from 'react';
import { ArrowLeft, Download, FileBox, Loader2, MessageSquare, Trash2, X } from 'lucide-react';
import { Markdown } from '@/lib/markdown';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SelectMenu } from '@/components/ui/select-menu';
import { APP_IFRAME_SANDBOX } from '@/lib/artifactSandbox';
import { useArtifacts, type ArtifactRow } from '@/stores/artifacts';
import { cn } from '@/lib/utils';

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
  const { rows, loaded, open, busy, error, lastExport, refresh, close } = useArtifacts();

  // The list is also kept current by `artifact` events, which arrive from every
  // surface. This is only the first read, for the case where the panel is
  // opened before anything has happened in this session.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <aside className="flex w-[26rem] shrink-0 flex-col border-l border-border-default bg-bg-surface">
      <header className="flex items-center gap-2 border-b border-border-subtle px-3 py-2.5">
        {open ? (
          <button
            type="button"
            onClick={close}
            aria-label="Back to the list"
            className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text-primary"
          >
            <ArrowLeft size={16} />
          </button>
        ) : (
          <FileBox size={16} className="text-warning" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
          {open ? open.row.title : 'Workspace'}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the workspace"
          className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text-primary"
        >
          <X size={16} />
        </button>
      </header>

      {error && (
        <p className="border-b border-border-subtle px-3 py-2 text-2xs text-(--warning)">{error}</p>
      )}

      {open ? (
        <Viewer onAsk={onAsk} />
      ) : (
        <List rows={rows} loaded={loaded} busy={busy} lastExport={lastExport} />
      )}
    </aside>
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

function Viewer({ onAsk }: { onAsk?: (row: ArtifactRow) => void }) {
  const { open, busy, lastExport, showVersion, exportArtifact, deleteArtifact } = useArtifacts();
  if (!open) return null;
  const { row, content, showing, versions } = open;

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border-subtle px-3 py-2">
        {versions.length > 1 && (
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
        )}
        <div className="flex-1" />
        {onAsk && (
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-2xs" onClick={() => onAsk(row)}>
            <MessageSquare size={12} /> Ask Cinderpaw
          </Button>
        )}
        <Button
          variant="ghost" size="sm" className="h-7 gap-1.5 text-2xs"
          disabled={busy}
          onClick={() => void exportArtifact(row.id)}
        >
          <Download size={12} /> Export
        </Button>
        <Button
          variant="ghost" size="sm" className="h-7 gap-1.5 text-2xs"
          disabled={busy}
          onClick={() => void deleteArtifact(row.id)}
        >
          <Trash2 size={12} /> Delete
        </Button>
      </div>

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

      <Preview kind={row.kind} title={row.title} content={content} />
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
    return (
      <iframe
        title={title}
        srcDoc={content}
        sandbox={APP_IFRAME_SANDBOX}
        className="flex-1 border-0 bg-white"
      />
    );
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
