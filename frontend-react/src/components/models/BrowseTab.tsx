import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AnimatePresence } from 'framer-motion';
import { AudioLines, FileText, Image, Layers, Search, Tag, X } from 'lucide-react';
import { HfModelCard, HfVariantsRow } from './HfModelCard';
import { BTN_OUTLINE, BTN_PRIMARY, CARD, MakerTile, Pill, SectionHeader, kindsOf, makerFor, type Filter } from './ui';
import { ModelLogo } from '@/lib/modelLogos';
import { useDownload } from '@/stores/download';
import { tauri, type HfModelSummary, type HfModelDetail } from '@/lib/tauri';
import { cn } from '@/lib/utils';

/** How many columns the card grid has right now: the same breakpoints as its
 *  `sm:grid-cols-2 xl:grid-cols-3`, so the opened row lands under the right
 *  row. jsdom has no matchMedia; it gets one column. */
function useGridCols(): number {
  const read = () => (window.matchMedia?.('(min-width: 80rem)').matches ? 3 : window.matchMedia?.('(min-width: 40rem)').matches ? 2 : 1);
  const [cols, setCols] = useState(read);
  useEffect(() => {
    const queries = ['(min-width: 80rem)', '(min-width: 40rem)'].map((q) => window.matchMedia?.(q)).filter(Boolean) as MediaQueryList[];
    const onChange = () => setCols(read());
    queries.forEach((q) => q.addEventListener('change', onChange));
    return () => queries.forEach((q) => q.removeEventListener('change', onChange));
  }, []);
  return cols;
}

const FILTERS: { id: Filter; label: string; icon?: React.ReactNode }[] = [
  { id: 'all', label: 'All' },
  { id: 'text', label: 'Text generation', icon: <FileText size={14} /> },
  { id: 'embed', label: 'Embeddings', icon: <Layers size={14} /> },
  { id: 'vision', label: 'Vision', icon: <Image size={14} /> },
  { id: 'audio', label: 'Audio', icon: <AudioLines size={14} /> },
  { id: 'small', label: 'Small (≤ 4B)', icon: <Tag size={14} /> },
];

export function BrowseTab() {
  const [query, setQuery]                   = useState('');
  const [results, setResults]               = useState<HfModelSummary[]>([]);
  const [nextCursor, setNextCursor]         = useState<string | null>(null);
  const [loading, setLoading]               = useState(false);
  const [error, setError]                   = useState<string | null>(null);
  const [filter, setFilter]                 = useState<Filter>('all');
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  // Cache of loaded details — keyed by repoId, populated by expand AND silent pill requests
  const [detailCache, setDetailCache]       = useState<Record<string, HfModelDetail>>({});
  // The card whose files are on the way: its chevron spins until they land.
  const [openingRepoId, setOpeningRepoId]   = useState<string | null>(null);
  const wantRepoId = useRef<string | null>(null);
  // Track silent fetches so we don't double-fetch
  const fetchingRef = useRef<Set<string>>(new Set());
  const popularLoaded = useRef(false);

  const doSearch = async (q: string, cursor?: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const page = await tauri.hf.search(q, cursor ?? null);
      if (cursor) {
        setResults((prev) => [...prev, ...page.models]);
      } else {
        setResults(page.models);
        setSelectedRepoId(null);
        setDetailCache({});
      }
      setNextCursor(page.next_cursor);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  // Load trending on first mount — once only
  useEffect(() => {
    if (popularLoaded.current) return;
    popularLoaded.current = true;
    void doSearch('');
  }, []);

  const handleSearch    = () => { void doSearch(query); };
  const handleLoadMore  = () => { if (nextCursor) void doSearch(query, nextCursor); };
  const handleKeyDown   = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') handleSearch();
  };

  // Shared fetch — populates cache; used by both expand and silent pill requests
  const fetchDetail = async (repoId: string): Promise<boolean> => {
    if (detailCache[repoId] || fetchingRef.current.has(repoId)) return false;
    fetchingRef.current.add(repoId);
    try {
      const d = await tauri.hf.detail(repoId);
      setDetailCache((prev) => ({ ...prev, [repoId]: d }));
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      fetchingRef.current.delete(repoId);
    }
  };

  // Opens only once the files are here. Opened first, the row grew to the
  // spinner's height and then again when the list landed, and moving to
  // another card shrank it to the spinner and grew it back: the cards below
  // bounced each time.
  const handleExpand = async (repoId: string) => {
    if (selectedRepoId === repoId) {
      wantRepoId.current = null;
      setOpeningRepoId(null);
      setSelectedRepoId(null);
      return;
    }
    wantRepoId.current = repoId;
    // A fetch the Install button already started opens at once, on the spinner.
    if (!detailCache[repoId] && !fetchingRef.current.has(repoId)) {
      setOpeningRepoId(repoId);
      const ok = await fetchDetail(repoId);
      if (wantRepoId.current !== repoId) return; // another card was picked meanwhile
      setOpeningRepoId(null);
      if (!ok) return; // the error shows above the grid
    } else {
      setOpeningRepoId(null);
    }
    setSelectedRepoId(repoId);
  };

  // Silent — loads detail into cache without expanding the card
  const handleRequestDetail = (repoId: string) => { void fetchDetail(repoId); };

  // The filters sort what the Hub already sent; they do not search again, so
  // an empty filter says so and points at the search box.
  const shown = useMemo(
    () => (filter === 'all' ? results : results.filter((m) => kindsOf(m).has(filter))),
    [results, filter],
  );

  // The opened card's details go after the LAST card of its row.
  const cols = useGridCols();
  const selectedIndex = shown.findIndex((m) => m.id === selectedRepoId);
  const selected = selectedIndex >= 0 ? shown[selectedIndex] : null;
  const rowEnd = selected ? Math.min(shown.length - 1, Math.floor(selectedIndex / cols) * cols + cols - 1) : -1;

  return (
    <div className="space-y-5">
      <SectionHeader title="Hugging Face Hub" subtitle="Browse, download, and run models from the community.">
        <Pill tone="neutral"><ModelLogo provider="huggingface" className="size-3.5" /> Public GGUF models, no account needed</Pill>
      </SectionHeader>

      {/* Search */}
      <div className="flex gap-2">
        <label className={cn(CARD, 'flex h-12 flex-1 items-center gap-3 px-4 focus-within:ring-2 focus-within:ring-brand/30')}>
          <Search size={16} className="shrink-0 text-text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search models, e.g. qwen, llama, gemma…"
            aria-label="Search models on HuggingFace"
            className="h-full min-w-0 flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-muted focus:outline-hidden"
          />
          {query && (
            <button type="button" onClick={() => { setQuery(''); void doSearch(''); }} aria-label="Clear search" title="Clear search" className="text-text-muted hover:text-text-primary">
              <X size={14} />
            </button>
          )}
        </label>
        <button type="button" onClick={handleSearch} disabled={loading} className={cn(BTN_PRIMARY, 'h-12 px-5')}>
          Search
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by kind">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            aria-pressed={filter === f.id}
            className={cn(
              'inline-flex h-9 items-center gap-1.5 rounded-xl border px-3.5 text-sm font-medium transition-colors',
              filter === f.id
                ? 'border-brand/30 bg-brand/10 text-brand'
                : 'border-border-subtle bg-bg-surface text-text-secondary hover:bg-bg-hover hover:text-text-primary',
            )}
          >
            {f.icon}{f.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-xl border border-error/30 bg-error/10 p-3 text-sm text-error">{error}</div>
      )}

      {loading && results.length === 0 && (
        <div className="flex justify-center py-8 text-sm text-text-muted">Searching...</div>
      )}

      {/* #19: empty state — a silent blank list after a search read as a bug */}
      {!loading && !error && shown.length === 0 && (
        <div className="flex flex-col items-center gap-1 py-10 text-center">
          <p className="text-sm text-text-secondary">
            {results.length > 0
              ? 'None of these results match that filter'
              : query.trim() ? `No GGUF models found for “${query.trim()}”` : 'No models to show right now'}
          </p>
          <p className="text-xs text-text-muted">
            Try another search term, e.g. a model family like “qwen”, “llama” or “gemma”.
          </p>
        </div>
      )}

      {/* Row spacing is each card's own margin, not the grid's row gap: see HfVariantsRow. */}
      <div className="grid gap-x-4 sm:grid-cols-2 xl:grid-cols-3 [&>article]:mb-4">
        {shown.map((m, i) => (
          <Fragment key={m.id}>
            <HfModelCard
              model={m}
              expanded={selectedRepoId === m.id}
              opening={openingRepoId === m.id}
              detail={detailCache[m.id] ?? null}
              onExpand={handleExpand}
              onRequestDetail={handleRequestDetail}
            />
            {/* Keyed by row, not by model: another card in the same row swaps the contents in place. */}
            <AnimatePresence initial={false}>
              {i === rowEnd && selected && (
                <HfVariantsRow key={`row-${rowEnd}`} model={selected} detail={detailCache[selected.id] ?? null} />
              )}
            </AnimatePresence>
          </Fragment>
        ))}
      </div>

      {nextCursor && (
        <div className="flex justify-center pt-2">
          <button type="button" onClick={handleLoadMore} disabled={loading} className={BTN_OUTLINE}>
            {loading ? 'Loading...' : 'Load more'}
          </button>
        </div>
      )}

      <DownloadsPanel />
    </div>
  );
}

/** The download in flight, pinned to the bottom of the page while it runs,
 *  so browsing on does not hide it. The host downloads one file at a time. */
function DownloadsPanel() {
  const active = useDownload((s) => s.active);
  const error = useDownload((s) => s.error);
  if (!active && !error) return null;

  const name = active ? active.repoId.split('/').pop() ?? active.repoId : '';
  const pct = active ? active.progress * 100 : 0;
  return (
    <div className={cn(CARD, 'sticky bottom-4 z-10 p-4 shadow-lg')}>
      <h3 className="mb-2 text-sm font-semibold text-text-primary">Downloads {active && <span className="font-normal text-text-muted">(1)</span>}</h3>
      {active && (
        <div className="flex items-center gap-3">
          <MakerTile maker={makerFor(active.repoId)} fallback={name} className="size-9 rounded-xl" />
          <div className="min-w-0 w-56 shrink-0">
            <p className="truncate text-sm font-medium text-text-primary">{name}</p>
            <p className="truncate text-2xs text-text-muted" title={active.filename}>{active.filename}</p>
          </div>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-elevated" role="progressbar" aria-valuenow={Math.round(pct)} aria-label={`Downloading ${name}`}>
            <div className="h-full rounded-full bg-brand transition-all duration-(--motion-slow)" style={{ width: `${pct}%` }} />
          </div>
          <span className="w-10 text-right text-sm tabular-nums text-text-secondary">{pct.toFixed(0)}%</span>
          <button
            type="button"
            onClick={() => void useDownload.getState().cancel()}
            aria-label="Cancel download"
            title="Cancel download"
            className="inline-flex size-8 items-center justify-center rounded-full border border-border-subtle text-text-muted hover:bg-bg-hover hover:text-error"
          >
            <X size={14} />
          </button>
        </div>
      )}
      {!active && error && <p className="text-xs text-error">Download failed: {error}</p>}
    </div>
  );
}
