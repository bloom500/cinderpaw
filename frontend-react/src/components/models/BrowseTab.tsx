import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { HfModelCard } from './HfModelCard';
import { tauri, type HfModelSummary, type HfModelDetail } from '@/lib/tauri';

export function BrowseTab() {
  const [query, setQuery]                   = useState('');
  const [results, setResults]               = useState<HfModelSummary[]>([]);
  const [nextCursor, setNextCursor]         = useState<string | null>(null);
  const [loading, setLoading]               = useState(false);
  const [error, setError]                   = useState<string | null>(null);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  // Cache of loaded details — keyed by repoId, populated by expand AND silent pill requests
  const [detailCache, setDetailCache]       = useState<Record<string, HfModelDetail>>({});
  const [detailLoading, setDetailLoading]   = useState(false);
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
  const fetchDetail = async (repoId: string) => {
    if (detailCache[repoId] || fetchingRef.current.has(repoId)) return;
    fetchingRef.current.add(repoId);
    try {
      const d = await tauri.hf.detail(repoId);
      setDetailCache((prev) => ({ ...prev, [repoId]: d }));
    } catch (e) {
      setError(String(e));
    } finally {
      fetchingRef.current.delete(repoId);
    }
  };

  const handleExpand = async (repoId: string) => {
    if (selectedRepoId === repoId) { setSelectedRepoId(null); return; }
    setSelectedRepoId(repoId);
    if (!detailCache[repoId]) {
      setDetailLoading(true);
      await fetchDetail(repoId);
      setDetailLoading(false);
    }
  };

  // Silent — loads detail into cache without expanding the card
  const handleRequestDetail = (repoId: string) => { void fetchDetail(repoId); };

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex gap-2 px-4 py-3 border-b border-border-subtle shrink-0">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search models on HuggingFace..."
            className="pl-8"
          />
        </div>
        <Button onClick={handleSearch} disabled={loading} variant="outline">
          Search
        </Button>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto py-4
        [&::-webkit-scrollbar]:w-[3px]
        [&::-webkit-scrollbar-track]:bg-transparent
        [&::-webkit-scrollbar-thumb]:bg-white/10
        [&::-webkit-scrollbar-thumb]:rounded-full
        hover:[&::-webkit-scrollbar-thumb]:bg-white/20"
      >
        <div className="max-w-3xl mx-auto px-6 space-y-1.5">
          {error && (
            <div className="text-error text-sm p-3 rounded bg-bg-surface border border-error">
              {error}
            </div>
          )}

          {loading && results.length === 0 && (
            <div className="flex justify-center py-8 text-text-muted text-sm">Searching...</div>
          )}

          {/* #19: empty state — a silent blank list after a search read as a bug */}
          {!loading && !error && results.length === 0 && (
            <div className="flex flex-col items-center gap-1 py-10 text-center">
              <p className="text-sm text-text-secondary">
                {query.trim() ? `No GGUF models found for “${query.trim()}”` : 'No models to show right now'}
              </p>
              <p className="text-xs text-text-muted">
                Try another search term, e.g. a model family like “qwen”, “llama” or “gemma”.
              </p>
            </div>
          )}

          {results.map((m) => (
            <HfModelCard
              key={m.id}
              model={m}
              expanded={selectedRepoId === m.id}
              detail={detailCache[m.id] ?? null}
              detailLoading={selectedRepoId === m.id && detailLoading}
              onExpand={handleExpand}
              onRequestDetail={handleRequestDetail}
            />
          ))}

          {nextCursor && (
            <div className="flex justify-center pt-2 pb-4">
              <Button
                variant="outline"
                onClick={handleLoadMore}
                disabled={loading}
              >
                {loading ? 'Loading...' : 'Load more'}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
