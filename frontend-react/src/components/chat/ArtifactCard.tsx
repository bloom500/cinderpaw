import { useEffect, useMemo, useRef, useState } from 'react';
import { AppWindow, ArrowRight, Code, Download, FileBox, FileText, Image as ImageIcon, LayoutDashboard, Share2, Table } from 'lucide-react';
import { BoardView } from '@/components/board/BoardView';
import { parseBoard } from '@/lib/board';
import type { ArtifactFact } from '@/hooks/useLiveToolActivity';
import { googlePlan, peekArtifact, shownKind, useArtifacts, type ArtifactRow } from '@/stores/artifacts';
import { ArtifactCover } from '@/components/artifacts/ArtifactCover';
import { LiveFrame } from '@/components/artifacts/LiveFrame';
import { MIN_SECTIONS, digest, plainText, sectionsOf, statusOf, subtitleOf, summaryOf, type DocSection } from '@/lib/artifactSections';
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
  board:    { icon: LayoutDashboard, word: 'Board' },
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
const READABLE = new Set(['document', 'markdown', 'app', 'html', 'table', 'code', 'json', 'board']);
/** Kinds the sidecar turns into a PDF on export (mirrors CONVERTIBLE in the store). */
const PDF_ABLE = new Set(['document', 'markdown', 'table', 'code', 'json', 'board']);
/** Section columns on the card; the rest are chips in the footer. */
const COLUMNS = 4;
const CHIPS = 4;
const BOARD_WIDTH = 'min(calc(100cqw - 48px), 1040px)';
/** A board in the chat is a preview: laid out at its full width, then drawn
 *  smaller as a whole. `zoom` re-lays text and charts at the smaller size, so
 *  they stay sharp, and photos only gain density. The panel shows it at 1:1. */
const BOARD_ZOOM = 0.72;
const BOARD_BREAKOUT = { width: BOARD_WIDTH, marginLeft: `calc(50% - ${BOARD_WIDTH} / 2)` };

/** The boards' chip tints, in order. */
const TINTS = ['bg-brand/10 text-brand', 'bg-error/10 text-error', 'bg-info/10 text-info', 'bg-success/10 text-success'];

/** Open in the side panel; with a section, straight to it (the deep dive). */
function openInPanel(id: string, section?: string) {
  useArtifacts.setState({ panelOpen: true, panelTab: 'artifacts' });
  void (section ? useArtifacts.getState().openArtifact(id, section) : useArtifacts.getState().openArtifact(id));
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

/** A remote picture, or nothing: one that fails must not leave a broken icon. */
function Picture({ src, className }: { src: string; className?: string }) {
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
      className={cn('block w-full object-cover', className)}
    />
  );
}

/**
 * A plan at a glance (the GTM and Trip boards, 1 Oct): the intro as a lead
 * line, the sections' pictures as a strip, then the first sections as numbered
 * columns with their first lines and points. Every part opens the panel on
 * that section; the card is the summary, the panel is the deep dive.
 */
function SectionOverview({ sections, subtitle, onSection }: { sections: DocSection[]; subtitle: string; onSection: (title: string) => void }) {
  const intro = sections[0]?.title === 'Overview' ? sections[0] : null;
  const parts = intro ? sections.slice(1) : sections;
  const pictures = parts.filter((s) => s.image).slice(0, 3);
  // The intro's first line is often the subtitle the header already shows.
  const introBody = intro && subtitle
    ? intro.body.split(/\n\s*\n/).filter((b) => plainText(b) !== subtitle).join('\n\n')
    : intro?.body ?? '';
  const lead = digest(introBody).lead;
  return (
    <div className="flex flex-col gap-4 px-5 pb-5">
      {lead && <p className="text-base leading-relaxed text-text-secondary">{lead}</p>}
      {pictures.length === 1 && (
        <button type="button" onClick={() => onSection(pictures[0].title)} className="overflow-hidden rounded-2xl border border-border-subtle">
          <Picture src={pictures[0].image!} className="aspect-[21/9]" />
        </button>
      )}
      {pictures.length > 1 && (
        <div className={cn('grid gap-3', pictures.length === 2 ? 'grid-cols-2' : 'grid-cols-3')}>
          {pictures.map((s) => (
            <button
              key={s.title}
              type="button"
              onClick={() => onSection(s.title)}
              className="overflow-hidden rounded-2xl border border-border-subtle bg-bg-elevated/60 text-left transition-colors hover:border-brand/40"
            >
              <Picture src={s.image!} className="aspect-[4/3]" />
              <span className="block truncate px-3 py-2 font-display text-base text-text-primary">{s.title}</span>
            </button>
          ))}
        </div>
      )}
      {/* Two per row on a narrow card, all of them from 40rem. Side by side at
          10.5rem each, four columns needed 708px in a 660px card and the
          fourth was cut off behind a sideways scroll (2 Oct). */}
      <div
        className="grid grid-cols-2 gap-3 @[40rem]:grid-cols-(--cols)"
        style={{ '--cols': `repeat(${Math.min(parts.length, COLUMNS)}, minmax(0, 1fr))` } as React.CSSProperties}
      >
        {parts.slice(0, COLUMNS).map((s, i) => {
          const { lead: first, points } = digest(s.body);
          return (
            <button
              key={s.title}
              type="button"
              onClick={() => onSection(s.title)}
              className="flex flex-col gap-2 rounded-2xl border border-border-subtle bg-bg-elevated/50 p-4 text-left transition-colors hover:border-brand/40"
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand/10 text-sm font-medium text-brand">{i + 1}</span>
              <span className="break-words font-display text-lg leading-snug text-text-primary">{s.title}</span>
              {first && <span className="line-clamp-4 text-sm leading-relaxed text-text-muted">{first}</span>}
              {points.length > 0 && (
                <ul className="mt-auto flex flex-col gap-1.5 border-t border-border-subtle pt-2.5">
                  {points.map((p) => (
                    <li key={p} className="flex gap-2 text-xs leading-snug text-text-secondary">
                      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                      <span className="line-clamp-2">{p}</span>
                    </li>
                  ))}
                </ul>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A Markdown document with no sections to speak of, minus its own title (the header has it). */
function ShortDocument({ content, subtitle }: { content: string; subtitle: string }) {
  // The header already shows the title and the line under it.
  const body = content
    .replace(/^\s*#\s.*(\r?\n)+/, '')
    .split(/\n\s*\n/)
    .filter((b, i) => !(i === 0 && subtitle && plainText(b) === subtitle))
    .join('\n\n');
  return (
    <div className="relative max-h-80 overflow-hidden px-5 pb-5 text-sm">
      <Markdown>{body}</Markdown>
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-linear-to-t from-bg-surface to-transparent" />
    </div>
  );
}

type Peek = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; content: string; row: ArtifactRow };

/** An export's receipt: the file already went somewhere, so the row only reopens it. */
function Receipt({ f }: { f: ArtifactFact }) {
  const Icon = (KINDS[f.kind] ?? OTHER).icon;
  return (
    <div className="flex items-center gap-3.5 rounded-2xl border border-border-default bg-bg-surface py-3 pl-3.5 pr-3">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-bg-active text-brand"><Icon size={20} /></span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-semibold text-text-primary" title={f.title}>{f.title}</span>
        <span className="truncate text-2xs text-text-disabled">{artifactLine(f)}</span>
      </span>
      <button
        type="button"
        onClick={() => openInPanel(f.id)}
        aria-label={`Open ${f.title}`}
        className="h-8 shrink-0 rounded-lg border border-border-default bg-bg-elevated px-3.5 text-sm font-medium text-text-primary transition-colors hover:bg-text-primary/5"
      >
        Open
      </button>
    </div>
  );
}

/**
 * What a reply made, as a card in the chat (Darius's boards of 1 Oct: System
 * Diagram, GTM Strategy, Performance Charts, Trip Planning, Marketing Strategy).
 *
 * The header is the same for every kind: icon tile, serif title, the line under
 * it, a status pill. The body is the thing itself at a glance: a plan's
 * sections as numbered columns (and its pictures as a strip), a chart or
 * diagram page live and interactive, a short note as its text. The footer's
 * chips and the orange arrow open the side panel, at a section when there is
 * one: the card is the summary, the panel is the deep dive.
 *
 * The text is read through `peekArtifact`, so drawing a card never changes what
 * the panel has open. An export receipt (it has a `path`) stays a small row.
 */
export function ArtifactCard({ f }: { f: ArtifactFact }) {
  if (f.path) return <Receipt f={f} />;
  return <DocumentCard f={f} />;
}

function DocumentCard({ f }: { f: ArtifactFact }) {
  const Icon = (KINDS[f.kind] ?? OTHER).icon;
  const [ref, onScreen] = useOnScreen<HTMLDivElement>();
  const readable = READABLE.has(f.kind);
  const [peek, setPeek] = useState<Peek>({ state: readable ? 'loading' : 'failed' });
  const [googleOk, setGoogleOk] = useState(false);
  const [shared, setShared] = useState(false);
  const google = useArtifacts((s) => s.google);
  const busy = useArtifacts((s) => s.busy);

  useEffect(() => {
    if (!readable) return;
    let live = true;
    peekArtifact(f.id, f.version).then(
      (r) => live && setPeek({ state: 'ready', content: r.content, row: r.row }),
      () => live && setPeek({ state: 'failed' }),
    );
    return () => { live = false; };
  }, [f.id, f.version, readable]);

  // A build without Cinderpaw's Google registration gets no Share, not one that only fails.
  useEffect(() => {
    tauri.google.status().then((s) => setGoogleOk(s !== null), () => setGoogleOk(false));
  }, []);

  const content = peek.state === 'ready' ? peek.content : '';
  const board = useMemo(() => (f.kind === 'board' && content ? parseBoard(content) : null), [f.kind, content]);
  const shown = shownKind(f.kind, content);
  const sections = useMemo(() => (shown === 'markdown' || shown === 'document' ? sectionsOf(shown, content) : []), [shown, content]);
  const sectioned = peek.state === 'ready' && sections.length >= MIN_SECTIONS;
  const live = peek.state === 'ready' && (shown === 'app' || shown === 'html');
  const ownSubtitle = peek.state === 'ready' ? subtitleOf(shown, content) : '';
  const subtitle = ownSubtitle || `${artifactLine(f)}${sectioned ? `, ${sections.length} sections` : ''}`;
  const parts = sections[0]?.title === 'Overview' ? sections.slice(1) : sections;
  const chips = sectioned ? parts.slice(COLUMNS, COLUMNS + CHIPS) : [];
  const more = sectioned ? Math.max(0, parts.length - COLUMNS - CHIPS) : 0;

  let body: React.ReactNode;
  if (peek.state === 'loading') {
    body = <div className="mx-5 mb-5 h-44 animate-pulse rounded-2xl bg-bg-active" aria-label="Loading" />;
  } else if (sectioned) {
    body = <SectionOverview sections={sections} subtitle={ownSubtitle} onSection={(title) => openInPanel(f.id, title)} />;
  } else if (live) {
    body = (
      <div className="mx-5 mb-5 h-[26rem] overflow-hidden rounded-2xl border border-border-subtle">
        {onScreen
          ? <LiveFrame title={f.title} content={content} className="h-full w-full" />
          : <ArtifactCover title={f.title} kind={f.kind} className="h-full w-full" />}
      </div>
    );
  } else if (peek.state === 'ready' && shown === 'markdown') {
    body = <ShortDocument content={content} subtitle={ownSubtitle} />;
  } else {
    const words = peek.state === 'ready' ? summaryOf(shown, content) : '';
    body = (
      <div className="flex flex-col gap-3 px-5 pb-5">
        <ArtifactCover title={f.title} kind={f.kind} className="h-36 rounded-2xl border border-border-subtle" />
        {words && <p className="line-clamp-4 text-sm text-text-secondary">{words}</p>}
      </div>
    );
  }

  const asPdf = PDF_ABLE.has(f.kind);
  const canShare = googleOk && peek.state === 'ready' && googlePlan(shown) !== null;
  const iconButton = 'flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border-default bg-bg-elevated text-text-secondary transition-colors hover:bg-text-primary/5 hover:text-text-primary disabled:opacity-60';

  // A board draws its own header and footer (the 1 Oct boards); the card adds its buttons to that footer.
  // It breaks out of the 700px reading column to the chat area's own width
  // (MessageList's scroller is the container), so it never runs under the
  // sidebar or the side panel, and still lands centred on the column.
  if (board && peek.state === 'ready') {
    return (
      <div ref={ref} data-board-breakout style={BOARD_BREAKOUT}>
        <div style={{ zoom: BOARD_ZOOM }}>
          <BoardView
            board={board}
            seed={`${f.id}:${board.title}`}
            status={statusOf(f.version, peek.row.updatedAt)}
            onSection={() => openInPanel(f.id)}
            actions={
              <>
                <button
                  type="button"
                  disabled={busy}
                  aria-label="Download PDF"
                  title="Download PDF"
                  onClick={() => void useArtifacts.getState().exportArtifact(f.id, { as: 'pdf', row: { title: f.title, kind: f.kind }, version: f.version })}
                  className={iconButton}
                >
                  <Download size={16} />
                </button>
                <button
                  type="button"
                  onClick={() => openInPanel(f.id)}
                  aria-label={`Open ${f.title}`}
                  title="Open in Artifacts"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand text-white transition-colors hover:bg-brand-hover"
                >
                  <ArrowRight size={20} />
                </button>
              </>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div ref={ref} className="@container overflow-hidden rounded-3xl border border-border-default bg-bg-surface shadow-[0_10px_30px_-14px_rgba(120,60,20,0.22)]">
      <div className="flex items-start gap-4 p-5 pb-4">
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-brand/10 text-brand">
          <Icon size={28} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="line-clamp-2 font-display text-2xl leading-tight text-text-primary" title={f.title}>{f.title}</span>
          <span className="truncate text-sm text-text-muted">{subtitle}</span>
        </span>
        {peek.state === 'ready' && (
          <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-success/10 px-3 py-1 text-xs font-medium text-success">
            <span className="h-2 w-2 rounded-full bg-success" />
            {statusOf(f.version, peek.row.updatedAt)}
          </span>
        )}
      </div>

      {body}

      <div className="flex items-center gap-2 border-t border-border-subtle px-5 py-3">
        <div className="flex min-w-0 flex-1 flex-wrap gap-2">
          {chips.map((s, i) => (
            <button
              key={s.title}
              type="button"
              onClick={() => openInPanel(f.id, s.title)}
              className={cn('max-w-full truncate rounded-full px-3.5 py-1.5 text-sm font-medium transition-opacity hover:opacity-80', TINTS[i % TINTS.length])}
            >
              {s.title}
            </button>
          ))}
          {more > 0 && (
            <button type="button" onClick={() => openInPanel(f.id)} className="shrink-0 rounded-full bg-bg-active px-3.5 py-1.5 text-sm text-text-secondary">
              {`+${more} more`}
            </button>
          )}
          {shared && google && (
            <span className={cn('self-center text-2xs', google.error ? 'text-(--warning)' : 'text-text-muted')}>
              {google.busy
                ? 'Sending to Google Drive…'
                : google.error
                  ? google.error
                  : google.link && <a href={google.link} target="_blank" rel="noreferrer" className="text-brand underline">Open in Google Drive</a>}
            </span>
          )}
        </div>
        <button
          type="button"
          disabled={busy}
          aria-label={asPdf ? 'Download PDF' : 'Download'}
          title={asPdf ? 'Download PDF' : 'Download'}
          onClick={() => void useArtifacts.getState().exportArtifact(f.id, { as: asPdf ? 'pdf' : undefined, row: { title: f.title, kind: f.kind }, version: f.version })}
          className={iconButton}
        >
          <Download size={16} />
        </button>
        {canShare && (
          <button
            type="button"
            aria-label="Share"
            title="Share to Google Drive"
            disabled={google?.busy === true}
            onClick={() => {
              setShared(true);
              void useArtifacts.getState().sendToGoogle({ title: f.title, kind: f.kind, content });
            }}
            className={iconButton}
          >
            <Share2 size={16} />
          </button>
        )}
        <button
          type="button"
          onClick={() => openInPanel(f.id)}
          aria-label={`Open ${f.title}`}
          title="Open in Artifacts"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand text-white transition-colors hover:bg-brand-hover"
        >
          <ArrowRight size={20} />
        </button>
      </div>
    </div>
  );
}
