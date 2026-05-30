import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useUI } from '@/stores/ui';
import { useConversations, type ConversationSummary } from '@/stores/conversations';
import { tauri, type Conversation } from '@/lib/tauri';

interface SearchResult {
  conv: ConversationSummary;
  snippet: string | null;
}

function highlight(text: string, query: string): React.ReactNode {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-brand/30 text-text-primary rounded-sm not-italic">
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  );
}

function relativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins  = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days  = Math.floor(diff / 86_400_000);
  if (mins  < 1)  return 'just now';
  if (mins  < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days  < 30) return `${days}d ago`;
  return new Date(isoString).toLocaleDateString();
}

export function SearchOverlay() {
  const closeSearch = useUI((s) => s.closeSearch);
  const navigate    = useNavigate();
  const convOpen    = useConversations((s) => s.open);
  const allConvs    = useConversations((s) => s.list);

  const [query, setQuery]     = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const inputRef              = useRef<HTMLInputElement>(null);
  const cacheRef              = useRef<Map<string, Conversation>>(new Map());
  const debounceRef           = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const runSearch = useCallback(async (q: string) => {
    if (!q.trim()) { setResults([]); return; }
    const lower = q.toLowerCase();

    // Immediate title matches
    const titleMatches = allConvs
      .filter((c) => c.title.toLowerCase().includes(lower))
      .map((c): SearchResult => ({ conv: c, snippet: null }));
    setResults(titleMatches);

    // Load uncached full conversations in background
    const uncached = allConvs.filter((c) => !cacheRef.current.has(c.id));
    await Promise.all(
      uncached.map(async (c) => {
        try {
          const full = await tauri.conversations.load(c.id);
          cacheRef.current.set(c.id, full);
        } catch { /* skip unloadable convs */ }
      }),
    );

    // Re-run with full content
    const titleMatchIds = new Set(titleMatches.map((r) => r.conv.id));
    const final: SearchResult[] = [...titleMatches];

    for (const c of allConvs) {
      if (titleMatchIds.has(c.id)) continue;
      const full = cacheRef.current.get(c.id);
      if (!full) continue;
      for (const msg of full.messages) {
        const idx = msg.content.toLowerCase().indexOf(lower);
        if (idx !== -1) {
          const start = Math.max(0, idx - 40);
          const end   = Math.min(msg.content.length, idx + q.length + 60);
          const snip  = (start > 0 ? '…' : '') +
            msg.content.slice(start, end) +
            (end < msg.content.length ? '…' : '');
          final.push({ conv: c, snippet: snip });
          break;
        }
      }
    }
    setResults(final);
  }, [allConvs]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { void runSearch(query); }, 150);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, runSearch]);

  const handleSelect = async (convId: string) => {
    closeSearch();
    navigate('/chat');
    await convOpen(convId);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center pt-[15vh] backdrop-blur-md bg-black/40"
      onClick={closeSearch}
    >
      <div
        className="w-full max-w-[600px] px-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Pill input */}
        <div className="flex items-center gap-3 bg-bg-surface border border-bg-hover rounded-3xl px-4 h-[52px] shadow-xl">
          <Search size={18} className="text-text-muted shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') closeSearch(); }}
            placeholder="Search conversations…"
            className="flex-1 bg-transparent text-text-primary text-sm outline-none placeholder:text-text-muted"
          />
          <button
            onClick={closeSearch}
            className="text-text-muted hover:text-text-secondary shrink-0"
            aria-label="Close search"
          >
            <X size={18} />
          </button>
        </div>

        {/* Results */}
        {query.trim() && (
          <div className="mt-2 bg-bg-surface border border-bg-hover rounded-2xl overflow-hidden shadow-xl max-h-[60vh] overflow-y-auto">
            {results.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-text-disabled">
                No matches found
              </div>
            ) : (
              results.map((r) => (
                <button
                  key={r.conv.id}
                  type="button"
                  onClick={() => { void handleSelect(r.conv.id); }}
                  className="w-full text-left px-4 py-3 hover:bg-bg-hover transition-colors border-b border-bg-hover last:border-0"
                >
                  <div className="text-sm font-medium text-text-primary truncate">
                    {highlight(r.conv.title, query)}
                  </div>
                  {r.snippet && (
                    <div className="text-xs text-text-muted mt-0.5 line-clamp-2">
                      {highlight(r.snippet, query)}
                    </div>
                  )}
                  <div className="text-[11px] text-text-disabled mt-0.5">
                    {relativeTime(r.conv.updated_at)}
                  </div>
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
