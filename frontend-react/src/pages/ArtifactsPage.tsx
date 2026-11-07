import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Archive, ArchiveRestore, Search, X } from 'lucide-react';
import { useArtifacts, type ArtifactRow } from '@/stores/artifacts';
import { useBrowser } from '@/stores/browser';
import { useConversations } from '@/stores/conversations';
import { ArtifactThumbnail } from '@/components/artifacts/ArtifactThumbnail';
import { artifactKind } from '@/components/chat/ArtifactCard';
import { CinderpawMascot } from '@/components/chat/mascot/CinderpawMascot';
import { cn } from '@/lib/utils';

/**
 * Everything Cinderpaw made, as a gallery: the sidebar's Artifacts row.
 *
 * The side panel stays the place an artifact is read and edited; this page is
 * where one is found. A card opens the panel beside the chat, exactly as a chat
 * card does, so there is one viewer and not two that drift.
 */

type Filter = 'all' | 'documents' | 'tables' | 'apps' | 'files';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'documents', label: 'Documents' },
  { id: 'tables', label: 'Tables' },
  { id: 'apps', label: 'Apps' },
  { id: 'files', label: 'Files' },
];

/** Which filter a sidecar `ArtifactKind` falls under; anything new is a file. */
export function filterOf(kind: string): Exclude<Filter, 'all'> {
  if (kind === 'document' || kind === 'markdown' || kind === 'docx' || kind === 'pdf') return 'documents';
  if (kind === 'table') return 'tables';
  // Things you look at or use rather than read: charts, tools, pages, boards.
  if (kind === 'app' || kind === 'html' || kind === 'board') return 'apps';
  return 'files';
}

/** The sidecar's list cap for the panel and this page (`artifact_op` list in dispatch.ts). */
const LIST_LIMIT = 500;

type Art = 'doc' | 'pdf' | 'table' | 'board' | 'chart' | 'design' | 'motion';

/**
 * Only what `artifact_create` can really make. Design and Motion are `app`
 * artifacts (one HTML page that can draw and move); there is no slides kind, so
 * there is no Slides tile. Each starts a new chat with the words in the box and
 * stops there: the person finishes the sentence and sends it.
 */
type Tile = { label: string; hint: string; prompt: string; art: Art; isNew?: boolean };

const MAKE: Tile[] = [
  { label: 'Document', hint: 'Plans and reports', prompt: 'Write me a document about ', art: 'doc' },
  { label: 'PDF', hint: 'To sign or send', prompt: 'Make me a PDF of ', art: 'pdf' },
  { label: 'Table', hint: 'Opens in Excel', prompt: 'Make me a table of ', art: 'table' },
  { label: 'Board', hint: 'A plan at a glance', prompt: 'Make me a board that shows ', art: 'board', isNew: true },
  { label: 'Chart', hint: 'From your numbers', prompt: 'Make me an interactive chart of ', art: 'chart' },
  { label: 'Design', hint: 'A page or a poster', prompt: 'Design a one-page poster for ', art: 'design', isNew: true },
  { label: 'Motion', hint: 'A short animation', prompt: 'Make me a short animation that shows ', art: 'motion', isNew: true },
];

/** The fresh install's one tile: a whole request, ready to send. */
const FIRST: Tile = { label: 'A plan for this week', hint: 'One page, ready to print', prompt: 'Make me a one-page plan for this week.', art: 'doc' };

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

function edited(ms: number): string {
  const mins = Math.round((ms - Date.now()) / 60_000);
  if (mins > -1) return 'Edited just now';
  if (mins > -60) return `Edited ${rtf.format(mins, 'minute')}`;
  const hours = Math.round(mins / 60);
  if (hours > -24) return `Edited ${rtf.format(hours, 'hour')}`;
  const days = Math.round(hours / 24);
  if (days > -7) return `Edited ${rtf.format(days, 'day')}`;
  return `Edited ${new Date(ms).toLocaleDateString()}`;
}

export function ArtifactsPage() {
  const navigate = useNavigate();
  const rows = useArtifacts((s) => s.rows);
  const loaded = useArtifacts((s) => s.loaded);
  const error = useArtifacts((s) => s.error);
  const archived = useArtifacts((s) => s.showingArchived);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // Reads for itself, like Chats and Projects: arriving here before anything
  // else asked must still show the truth.
  useEffect(() => { void useArtifacts.getState().refresh(); }, []);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: rows.length, documents: 0, tables: 0, apps: 0, files: 0 };
    for (const r of rows) c[filterOf(r.kind)]++;
    return c;
  }, [rows]);
  const q = query.trim().toLocaleLowerCase();
  const shown = rows.filter((r) =>
    (filter === 'all' || filterOf(r.kind) === filter) && r.title.toLocaleLowerCase().includes(q));

  const compose = (text: string) => {
    useConversations.getState().newChat();
    navigate('/chat', { state: { compose: text } });
  };
  // The panel lives beside the chat, and the browser panel does not share the space.
  const openCard = (id: string) => {
    useBrowser.getState().setPanel(false);
    useArtifacts.setState({ panelOpen: true, panelTab: 'artifacts' });
    void useArtifacts.getState().openArtifact(id);
    navigate('/chat');
  };
  const clearSearch = () => { setQuery(''); searchRef.current?.focus(); };

  const fresh = loaded && !archived && rows.length === 0 && !error;
  const failed = loaded && rows.length === 0 && !!error;
  const sub = archived
    ? 'Archived work stays out of the list, and is never deleted.'
    : loaded && rows.length > 0
      ? `${rows.length >= LIST_LIMIT ? `Your ${LIST_LIMIT} newest` : rows.length} ${rows.length === 1 ? 'thing' : 'things'} Cinderpaw made for you.`
      : 'Everything Cinderpaw makes for you, in one place.';

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div data-tauri-drag-region className="h-10 shrink-0" />
      <div className="flex-1 overflow-y-auto scrollbar-hide">
        <div className="mx-auto max-w-5xl px-6 pb-14">
          <header className="flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">
              <h1 className="font-display text-3xl text-text-primary">{archived ? 'Archived' : 'Artifacts'}</h1>
              <p className="mt-1 text-sm text-text-muted">{sub}</p>
            </div>
            {loaded && rows.length > 0 && (
              <div className="flex h-10 w-full items-center gap-2 rounded-xl border border-border-default bg-bg-surface px-3 shadow-sm focus-within:ring-2 focus-within:ring-brand sm:w-72">
                <Search size={16} className="shrink-0 text-text-muted" aria-hidden />
                <input
                  ref={searchRef}
                  type="search"
                  aria-label="Search artifacts by title"
                  placeholder="Search by title"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); clearSearch(); } }}
                  className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-hidden placeholder:text-text-muted [&::-webkit-search-cancel-button]:hidden"
                />
                {query && (
                  <button type="button" aria-label="Clear search" onClick={clearSearch}
                    className="rounded p-0.5 text-text-muted hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand">
                    <X size={14} aria-hidden />
                  </button>
                )}
              </div>
            )}
          </header>

          {loaded && !archived && rows.length > 0 && (
            <section aria-label="Make something new" className="mt-8">
              <h2 className="mb-3 text-sm font-semibold text-text-primary">Make something new</h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-3">
                {MAKE.map((t) => <MakeTile key={t.label} tile={t} onPick={compose} />)}
              </div>
            </section>
          )}

          {loaded && (
            <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
              {rows.length > 0 ? (
                <div role="group" aria-label="Show" className="flex flex-wrap gap-1 rounded-xl border border-border-default bg-bg-side/60 p-1">
                  {FILTERS.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      aria-pressed={filter === f.id}
                      onClick={() => setFilter(f.id)}
                      className={cn(
                        'flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand',
                        filter === f.id ? 'bg-bg-elevated font-medium text-text-primary shadow-sm' : 'text-text-muted hover:text-text-primary',
                      )}
                    >
                      {f.label}
                      <span className="text-2xs tabular-nums text-text-muted">{counts[f.id]}</span>
                    </button>
                  ))}
                </div>
              ) : <span />}
              {/* Always there once loaded: someone who archived everything has an
                  empty list and still needs the way back to it. */}
              <button
                type="button"
                aria-pressed={archived}
                onClick={() => { setFilter('all'); setQuery(''); useArtifacts.getState().showArchived(!archived); }}
                className={cn(
                  'flex h-10 items-center gap-2 rounded-xl border px-3 text-sm transition-colors active:scale-[0.97] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand',
                  archived ? 'border-brand/40 bg-brand/10 text-text-primary' : 'border-border-default bg-bg-surface text-text-muted hover:text-text-primary',
                )}
              >
                <Archive size={16} aria-hidden />
                {archived ? 'Back to artifacts' : 'Archived'}
              </button>
            </div>
          )}

          <div className="mt-6">
            {!loaded ? (
              <CardSkeletons />
            ) : failed ? (
              <div className="flex flex-col items-start gap-3 rounded-2xl border border-border-default bg-bg-surface p-5">
                <p className="text-sm text-text-primary">Cinderpaw could not read your artifacts right now.</p>
                <button type="button" onClick={() => void useArtifacts.getState().refresh()}
                  className="h-9 rounded-xl border border-border-default bg-bg-elevated px-3 text-sm font-medium text-text-primary hover:bg-bg-hover active:scale-[0.97]">
                  Try again
                </button>
              </div>
            ) : fresh ? (
              <div className="mx-auto mt-4 flex max-w-xl flex-col items-center rounded-3xl border border-border-default bg-bg-surface px-8 pb-8 pt-6 text-center shadow-sm">
                <CinderpawMascot state="curious" width={96} />
                <h2 className="mt-3 font-display text-2xl text-text-primary">Your first artifact will live here</h2>
                <p className="mt-2 text-sm text-text-muted">
                  When Cinderpaw writes you a document, a table, a chart or a PDF, it is kept here, so you can open it again, change it or send it.
                </p>
                <MakeTile tile={FIRST} onPick={compose} className="mt-6 w-full max-w-60" />
              </div>
            ) : rows.length === 0 ? (
              <p className="py-10 text-center text-sm text-text-muted">Nothing archived. Archive keeps work out of the list without deleting it.</p>
            ) : shown.length === 0 ? (
              <p className="py-10 text-center text-sm text-text-muted">
                {q ? `No artifacts match "${query.trim()}".` : `No ${FILTERS.find((f) => f.id === filter)!.label.toLowerCase()} yet.`}
              </p>
            ) : (
              <ul className="grid grid-cols-1 gap-x-5 gap-y-7 sm:grid-cols-2 lg:grid-cols-3">
                {shown.map((r, i) => (
                  <li key={r.id}
                    className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-(--motion-slow) motion-reduce:animate-none"
                    // A short cascade on the first screen, nothing longer: by the
                    // thirteenth card the eye has stopped following it.
                    style={{ animationDelay: `${Math.min(i, 12) * 25}ms` }}>
                    <Card row={r} archived={archived} onOpen={() => openCard(r.id)} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Card({ row, archived, onOpen }: { row: ArtifactRow; archived: boolean; onOpen: () => void }) {
  const look = artifactKind(row.kind);
  return (
    <div className="group relative">
      <button type="button" onClick={onOpen}
        className="block w-full rounded-2xl text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-4 focus-visible:ring-offset-bg-primary">
        <span className="relative block aspect-[4/3] overflow-hidden rounded-2xl border border-border-default bg-bg-surface shadow-sm transition duration-(--motion-base) group-hover:border-brand/30 group-hover:shadow-md motion-reduce:transform-none">
          <ArtifactThumbnail row={row} size="page" className="h-full w-full" />
          <span title={look.word}
            className="absolute bottom-2.5 left-2.5 grid size-7 place-items-center rounded-lg border border-border-default bg-bg-elevated text-text-secondary shadow-sm">
            <look.icon size={14} aria-hidden />
          </span>
        </span>
        <span className="mt-3 block truncate px-0.5 text-sm font-semibold text-text-primary" title={row.title}>{row.title}</span>
        <span className="mt-0.5 block truncate px-0.5 text-xs text-text-muted">{`${look.word} · ${edited(row.updatedAt)}`}</span>
      </button>
      <button
        type="button"
        aria-label={`${archived ? 'Unarchive' : 'Archive'} ${row.title}`}
        title={archived ? 'Unarchive' : 'Archive'}
        onClick={() => void useArtifacts.getState().archiveArtifact(row.id, !archived)}
        className="absolute right-2.5 top-2.5 grid size-8 place-items-center rounded-lg border border-border-default bg-bg-elevated text-text-muted opacity-0 shadow-sm transition-opacity hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand group-hover:opacity-100"
      >
        {archived ? <ArchiveRestore size={16} aria-hidden /> : <Archive size={16} aria-hidden />}
      </button>
    </div>
  );
}

function MakeTile({ tile, onPick, className }: {
  tile: Tile;
  onPick: (prompt: string) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onPick(tile.prompt)}
      className={cn(
        'group flex flex-col gap-2.5 rounded-2xl border border-border-default bg-bg-surface p-2 text-left shadow-sm transition duration-(--motion-base) hover:border-brand/30 hover:shadow-md active:scale-[0.97] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand motion-reduce:transform-none',
        className,
      )}
    >
      <span className="relative grid h-16 place-items-center rounded-xl bg-bg-active/60 text-text-muted">
        <TileArt art={tile.art} />
        {tile.isNew && (
          <span className="absolute right-1.5 top-1.5 rounded-full bg-brand px-1.5 text-micro font-semibold text-brand-foreground">New</span>
        )}
      </span>
      <span className="min-w-0 px-1 pb-0.5">
        <span className="block text-sm font-semibold text-text-primary">{tile.label}</span>
        <span className="line-clamp-2 block text-2xs text-text-muted">{tile.hint}</span>
      </span>
    </button>
  );
}

/** A small drawing of what the tile makes, in the app's own colours. */
function TileArt({ art }: { art: Art }) {
  const page = 'fill-bg-elevated stroke-border-default';
  const ink = 'fill-text-muted/40';
  return (
    <svg viewBox="0 0 64 44" className="h-11 w-16" aria-hidden>
      {art === 'doc' && <>
        <rect x="18" y="3" width="28" height="38" rx="2" className={page} />
        <rect x="22" y="8" width="14" height="3" rx="1" className="fill-brand" />
        {[15, 20, 25, 30].map((y) => <rect key={y} x="22" y={y} width={y === 30 ? 12 : 20} height="2" rx="1" className={ink} />)}
      </>}
      {art === 'pdf' && <>
        <rect x="18" y="3" width="28" height="38" rx="2" className={page} />
        {[9, 14, 19].map((y) => <rect key={y} x="22" y={y} width="20" height="2" rx="1" className={ink} />)}
        <path d="M22 33c3-5 5 2 8-2s3 3 6 0 3-1 5-1" className="fill-none stroke-brand" strokeWidth="1.5" strokeLinecap="round" />
      </>}
      {art === 'table' && <>
        <rect x="12" y="7" width="40" height="30" rx="2" className={page} />
        <rect x="12" y="7" width="40" height="7" rx="2" className="fill-brand/20" />
        <path d="M12 14h40M12 21.5h40M12 29h40M25 7v30M38 7v30" className="stroke-border-default" />
      </>}
      {art === 'board' && <>
        <rect x="10" y="6" width="20" height="14" rx="2" className="fill-brand/25" />
        <rect x="34" y="6" width="20" height="32" rx="2" className={page} />
        <rect x="10" y="24" width="20" height="14" rx="2" className={page} />
        <rect x="38" y="11" width="12" height="2" rx="1" className={ink} />
      </>}
      {art === 'chart' && <>
        <path d="M12 38h40" className="stroke-border-default" />
        {[[16, 24], [24, 16], [32, 28], [40, 10], [48, 20]].map(([x, y]) => (
          <rect key={x} x={x - 2.5} y={y} width="5" height={38 - y} rx="1" className={x === 40 ? 'fill-brand' : 'fill-text-muted/30'} />
        ))}
      </>}
      {art === 'design' && <>
        <rect x="12" y="5" width="40" height="34" rx="2" className={page} />
        <circle cx="24" cy="18" r="6" className="fill-brand/70" />
        <rect x="33" y="13" width="14" height="3" rx="1" className={ink} />
        <rect x="33" y="19" width="10" height="2" rx="1" className={ink} />
        <rect x="17" y="29" width="30" height="5" rx="2" className="fill-brand/20" />
      </>}
      {art === 'motion' && (
        <g className="transition-transform duration-(--motion-slow) group-hover:translate-x-1.5 motion-reduce:transform-none">
          <circle cx="20" cy="22" r="4" className="fill-brand/20" />
          <circle cx="30" cy="22" r="5" className="fill-brand/45" />
          <circle cx="42" cy="22" r="7" className="fill-brand" />
        </g>
      )}
    </svg>
  );
}

/** The grid's shape before the first read comes back, so "empty" is never guessed. */
function CardSkeletons() {
  return (
    <div className="grid grid-cols-1 gap-x-5 gap-y-7 sm:grid-cols-2 lg:grid-cols-3" aria-hidden>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i}>
          <div className="aspect-[4/3] animate-pulse rounded-2xl bg-bg-hover" />
          <div className="mt-3 h-3.5 animate-pulse rounded bg-bg-hover" style={{ width: `${48 + ((i * 37) % 36)}%` }} />
          <div className="mt-2 h-2.5 w-24 animate-pulse rounded bg-bg-hover/70" />
        </div>
      ))}
    </div>
  );
}
