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
  const [detail, setDetail]                 = useState<HfModelDetail | null>(null);
  const [detailLoading, setDetailLoading]   = useState(false);
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
        setDetail(null);
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

  const handleExpand = async (repoId: string) => {
    if (selectedRepoId === repoId) {
      setSelectedRepoId(null);
      return;
    }
    setSelectedRepoId(repoId);
    setDetail(null);
    setDetailLoading(true);
    try {
      const d = await tauri.hf.detail(repoId);
      setDetail(d);
    } catch (e) {
      setError(String(e));
    } finally {
      setDetailLoading(false);
    }
  };

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
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2">
        {error && (
          <div className="text-error text-sm p-3 rounded bg-bg-surface border border-error">
            {error}
          </div>
        )}

        {loading && results.length === 0 && (
          <div className="flex justify-center py-8 text-text-muted text-sm">Searching...</div>
        )}

        {results.map((m) => (
          <HfModelCard
            key={m.id}
            model={m}
            expanded={selectedRepoId === m.id}
            detail={selectedRepoId === m.id ? detail : null}
            detailLoading={selectedRepoId === m.id && detailLoading}
            onExpand={handleExpand}
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
  );
}
