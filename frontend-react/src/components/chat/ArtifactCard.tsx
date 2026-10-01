import { useEffect, useMemo, useRef, useState } from 'react';
import { AppWindow, Code, Download, ExternalLink, FileBox, FileText, Image as ImageIcon, Table } from 'lucide-react';
import type { ArtifactFact } from '@/hooks/useLiveToolActivity';
import { googlePlan, peekArtifact, shownKind, useArtifacts } from '@/stores/artifacts';
import { ArtifactCover } from '@/components/artifacts/ArtifactCover';
import { LiveFrame } from '@/components/artifacts/LiveFrame';
import { MIN_SECTIONS, sectionsOf, summaryOf, type DocSection } from '@/lib/artifactSections';
import { Markdown } from '@/lib/markdown';
import { tauri } from '@/lib/tauri';
import { cn } from '@/lib/utils';

/** Icon and word per artifact kind (the sidecar's `ArtifactKind`). */
const KINDS: Record<string, { icon: typeof FileBox; word: string }> = {
  document: { icon: FileText,  word: 'Document' },
  markdown: { icon: FileText,  word: 'Document' },
  docx:     { icon: FileText,  word: 'Word document' },
  pdf:      { icon: FileText,  word: 'PDF' },
  app:      { icon: AppWindow, word: 'Interactive' },
  html:     { icon: AppWindow, word: 'Web page' },
  table:    { icon: Table,     word: 'Table' },
  code:     { icon: Code,      word: 'Code' },
  json:     { icon: Code,      word: 'Data' },
  image:    { icon: ImageIcon, word: 'Image' },
};
const OTHER = { icon: FileBox, word: 'File' };

/** The icon and word for a kind, "File" for one this list does not know. */
export function artifactKind(kind: string): { icon: typeof FileBox; word: string } {
  return KINDS[kind] ?? OTHER;
}

/** "Document, 12 KB": what it is and how big (the Artifact Dock's line). */
export function artifactSize(kind: string, bytes: number): string {
  const size = bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${artifactKind(kind).word}, ${size}`;
}

/** "Document", or "Document, v3" once it has been revised (the tool widget's form). */
export function artifactLine(f: Pick<ArtifactFact, 'kind' | 'version'>): string {
  const { word } = KINDS[f.kind] ?? OTHER;
  return f.version > 1 ? `${word}, v${f.version}` : word;
}

/** Kinds whose text the card can read and draw; the rest get their cover. */
const READABLE = new Set(['document', 'markdown', 'app', 'html', 'table', 'code', 'json']);
/** Kinds the sidecar turns into a PDF on export (mirrors CONVERTIBLE in the store). */
const PDF_ABLE = new Set(['document', 'markdown', 'table', 'code', 'json']);
/** Kinds the panel edits as text: only for these is "Open" an editor. */
const EDITORS = new Set(['document', 'markdown', 'table', 'code', 'json']);

function openInPanel(id: string) {
  useArtifacts.setState({ panelOpen: true, panelTab: 'artifacts' });
  void useArtifacts.getState().openArtifact(id);
}

/** True while the element is near the screen. With no observer (a test) always true. */
function useOnScreen<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setSeen(e.isIntersecting), { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, seen];
}

/** A section's picture, or nothing: a remote picture that fails must not leave a broken icon. */
function SectionPicture({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (failed) return null;
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="mb-3 aspect-[16/9] w-full rounded-xl border border-border-subtle object-cover"
    />
  );
}

/** Section list on the left (tabs when the chat is narrow), the chosen section on the right. */
function Sections({ sections }: { sections: DocSection[] }) {
  const [at, setAt] = useState(0);
  const sel = sections[Math.min(at, sections.length - 1)];
  return (
    <div className="grid gap-3 px-4 pb-4 @lg:grid-cols-[11rem_1fr] @lg:gap-5">
      <div role="tablist" aria-label="Sections" className="flex gap-1 overflow-x-auto @lg:max-h-72 @lg:flex-col @lg:overflow-y-auto">
        {sections.map((s, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={s === sel}
            onClick={() => setAt(i)}
            className={cn(
              'shrink-0 rounded-lg px-3 py-1.5 text-left text-sm transition-colors',
              s === sel ? 'bg-brand/10 font-medium text-brand' : 'text-text-secondary hover:bg-text-primary/5',
            )}
          >
            {s.title}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="min-w-0">
        {sel.image && <SectionPicture src={sel.image} />}
        <h4 className="mb-1.5 text-sm font-semibold text-text-primary">{sel.title}</h4>
        <div className="max-h-56 overflow-y-auto text-sm"><Markdown>{sel.body}</Markdown></div>
      </div>
    </div>
  );
}

type Peek = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; content: string };

/**
 * What a reply made, as a card (spec 6, and Darius's 1 Oct board): icon tile,
 * title, then the thing itself, then Open / Download / Share. What "the thing
 * itself" is depends on the kind: a plan with `##` sections is a list and the
 * chosen section; a chart or diagram (an `app`) is the live, interactive page;
 * anything else is its cover and a few words. The text is read through
 * `peekArtifact`, so drawing a card never changes what the panel has open.
 * An export receipt (it has a `path`) stays the small row it always was.
 */
export function ArtifactCard({ f }: { f: ArtifactFact }) {
  const Icon = (KINDS[f.kind] ?? OTHER).icon;
  const [ref, onScreen] = useOnScreen<HTMLDivElement>();
  const readable = READABLE.has(f.kind) && !f.path;
  const [peek, setPeek] = useState<Peek>({ state: readable ? 'loading' : 'failed' });
  const [googleOk, setGoogleOk] = useState(false);
  const [shared, setShared] = useState(false);
  const google = useArtifacts((s) => s.google);
  const busy = useArtifacts((s) => s.busy);

  useEffect(() => {
    if (!readable) return;
    let live = true;
    peekArtifact(f.id, f.version).then(
      (r) => live && setPeek({ state: 'ready', content: r.content }),
      () => live && setPeek({ state: 'failed' }),
    );
    return () => { live = false; };
  }, [f.id, f.version, readable]);

  // A build without Cinderpaw's Google registration gets no Share, not one that only fails.
  useEffect(() => {
    tauri.google.status().then((s) => setGoogleOk(s !== null), () => setGoogleOk(false));
  }, []);

  const content = peek.state === 'ready' ? peek.content : '';
  const shown = shownKind(f.kind, content);
  const sections = useMemo(() => (shown === 'markdown' || shown === 'document' ? sectionsOf(shown, content) : []), [shown, content]);
  const sectioned = peek.state === 'ready' && sections.length >= MIN_SECTIONS;
  const live = peek.state === 'ready' && (shown === 'app' || shown === 'html');

  let body: React.ReactNode;
  if (f.path) {
    body = null;
  } else if (peek.state === 'loading') {
    body = <div className="mx-4 mb-4 h-40 animate-pulse rounded-xl bg-bg-active" aria-label="Loading" />;
  } else if (sectioned) {
    body = <Sections sections={sections} />;
  } else if (live) {
    body = (
      <div className="mx-4 mb-4 h-80 overflow-hidden rounded-xl border border-border-subtle">
        {onScreen
          ? <LiveFrame title={f.title} content={content} className="h-full w-full" />
          : <ArtifactCover title={f.title} kind={f.kind} className="h-full w-full" />}
      </div>
    );
  } else {
    const words = peek.state === 'ready' ? summaryOf(shown, content) : '';
    body = (
      <div className="flex flex-col gap-3 px-4 pb-4">
        <ArtifactCover title={f.title} kind={f.kind} className="h-36 rounded-xl border border-border-subtle" />
        {peek.state === 'ready' && shown === 'markdown'
          ? <div className="max-h-48 overflow-y-auto text-sm"><Markdown>{content}</Markdown></div>
          : words && <p className="line-clamp-4 text-sm text-text-secondary">{words}</p>}
      </div>
    );
  }

  const asPdf = PDF_ABLE.has(f.kind);
  const canShare = googleOk && peek.state === 'ready' && googlePlan(shown) !== null;
  const button = 'flex h-9 items-center gap-1.5 rounded-xl border border-border-default bg-bg-elevated px-3.5 text-sm font-medium text-text-primary transition-colors hover:bg-text-primary/5 disabled:opacity-60';

  return (
    <div ref={ref} className="@container overflow-hidden rounded-2xl border border-border-default bg-bg-surface shadow-sm">
      <div className="flex items-center gap-3.5 p-4 pb-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-bg-active text-brand">
          <Icon size={20} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-base font-semibold text-text-primary" title={f.title}>{f.title}</span>
          <span className="truncate text-2xs text-text-disabled">
            {artifactLine(f)}{sectioned ? `, ${sections.length} sections` : ''}
          </span>
        </span>
      </div>

      {body}

      <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle p-3">
        <button type="button" onClick={() => openInPanel(f.id)} aria-label={`Open ${f.title}`} className={button}>
          <ExternalLink size={14} />
          {EDITORS.has(f.kind) ? 'Open in Editor' : 'Open'}
        </button>
        {!f.path && <button
          type="button"
          disabled={busy}
          onClick={() => void useArtifacts.getState().exportArtifact(f.id, { as: asPdf ? 'pdf' : undefined, row: { title: f.title, kind: f.kind } })}
          className={button}
        >
          <Download size={14} />
          {asPdf ? 'Download PDF' : 'Download'}
        </button>}
        {canShare && !f.path && (
          <button
            type="button"
            disabled={google?.busy === true}
            onClick={() => {
              setShared(true);
              void useArtifacts.getState().sendToGoogle({ title: f.title, kind: f.kind, content });
            }}
            className={button}
          >
            Share
          </button>
        )}
        {shared && google && (
          <span className={cn('text-2xs', google.error ? 'text-(--warning)' : 'text-text-muted')}>
            {google.busy
              ? 'Sending to Google Drive…'
              : google.error
                ? google.error
                : google.link && <a href={google.link} target="_blank" rel="noreferrer" className="text-brand underline">Open in Google Drive</a>}
          </span>
        )}
      </div>
    </div>
  );
}
