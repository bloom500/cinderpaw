import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Plus, Search, X } from 'lucide-react';
import { useConversations } from '@/stores/conversations';
import { useUI } from '@/stores/ui';
import { ConversationActions } from '@/components/items/ItemActions';
import { cn } from '@/lib/utils';
import { groupByRecency } from '@/lib/chatGroups';

/**
 * Every conversation, in the content area rather than in the rail.
 *
 * The rail shows five and stops. This is where the rest lives, along with the
 * two things that died when the old rail was deleted: which chat you are in,
 * and which chat is generating while you are looking at another one.
 */

function relative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * The strip a row occupies before its data arrives.
 *
 * Not decoration: this page reads from the store on mount, and until the read
 * lands it rendered "no conversations yet" — a fresh-install sentence shown to
 * someone who has hundreds. A skeleton says "loading", an empty-state sentence
 * says "empty", and telling a person the wrong one of those is worse than
 * telling them nothing.
 */
function RowSkeletons({ count = 5 }: { count?: number }) {
  return (
    <div className="space-y-1" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex flex-col gap-2 px-4 py-3">
          <div
            className="h-3.5 rounded bg-bg-hover animate-pulse"
            style={{ width: `${58 + ((i * 37) % 32)}%` }}
          />
          <div className="h-2.5 w-16 rounded bg-bg-hover/70 animate-pulse" />
        </div>
      ))}
    </div>
  );
}

export function ChatsPage() {
  const navigate = useNavigate();
  const list = useConversations((s) => s.list);
  const currentId = useConversations((s) => s.currentId);
  const streamingIds = useConversations((s) => s.streamingIds);
  const openSearch = useUI((s) => s.openSearch);
  const loading = !useConversations((s) => s.loaded);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = (list ?? []).filter((c) => c.title.toLocaleLowerCase().includes(normalizedQuery));
  const clearFilter = () => { setQuery(''); searchRef.current?.focus(); };

  // Sorting happens inside the grouping, which has to own it: a group list
  // built from an unsorted array interleaves its own headings.
  const groups = groupByRecency(filtered, (c) => c.updated_at);
  const total = (list ?? []).length;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div data-tauri-drag-region className="h-10 shrink-0" />
      <div className="flex-1 overflow-y-auto scrollbar-hide">
        <div className="max-w-3xl mx-auto px-6 pb-10">
          <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
            <h1 className="text-2xl font-semibold text-text-primary tracking-tight">Chats</h1>
            <button
              type="button"
              onClick={() => { useConversations.getState().newChat(); navigate('/chat'); }}
              className="inline-flex items-center gap-2 rounded-lg bg-bg-elevated px-3 py-2 text-sm text-text-primary hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              <Plus size={16} aria-hidden />
              New chat
            </button>
          </div>
          {!loading && total > 0 && (
            <div className="mb-6 space-y-2">
              <div className="flex items-center gap-2 rounded-xl border border-border-subtle bg-bg-surface px-3 focus-within:ring-2 focus-within:ring-brand">
                <Search size={16} className="shrink-0 text-text-muted" aria-hidden />
                <input
                  ref={searchRef}
                  type="search"
                  aria-label="Filter conversations by title"
                  placeholder="Filter by title…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); clearFilter(); } }}
                  className="min-w-0 flex-1 bg-transparent py-3 text-sm text-text-primary placeholder:text-text-muted outline-none [&::-webkit-search-cancel-button]:hidden"
                />
                {query && (
                  <button type="button" aria-label="Clear filter" onClick={clearFilter}
                    className="rounded p-1 text-text-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
                    <X size={16} aria-hidden />
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted">
                <span role="status">{filtered.length} of {total} conversations</span>
                <button
                  type="button"
                  onClick={() => openSearch()}
                  className="rounded text-text-muted hover:text-text-secondary cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  Search message content
                </button>
              </div>
            </div>
          )}

          {loading ? (
            <RowSkeletons />
          ) : total === 0 ? (
            <p className="text-sm text-text-muted">
              No conversations yet. Ask Cinderpaw something and it will show up here.
            </p>
          ) : filtered.length === 0 ? (
            <p className="py-6 text-sm text-text-muted">No matching conversations.</p>
          ) : (
            <div className="space-y-6">
              {groups.map((group) => (
                <section key={group.id}>
                  <h2 className="px-4 pb-1.5 text-xs font-semibold uppercase tracking-wider text-text-secondary">
                    {group.label}
                  </h2>
                  <div className="space-y-1">
                    {group.items.map((c) => (
                      <div
                        key={c.id}
                        className={cn(
                          'group flex items-center gap-2 rounded-xl pr-2 transition-colors',
                          c.id === currentId ? 'bg-bg-active' : 'hover:bg-bg-hover',
                        )}
                      >
                        <button
                          type="button"
                          aria-current={c.id === currentId ? 'page' : undefined}
                          onClick={() => { void useConversations.getState().open(c.id); navigate('/chat'); }}
                          className="flex-1 min-w-0 rounded-xl text-left px-4 py-3 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                        >
                          <span className="flex items-center gap-2">
                            {streamingIds[c.id] && (
                              <Loader2 size={12} className="shrink-0 animate-spin text-brand" aria-label="Generating" />
                            )}
                            <span className="text-sm text-text-primary truncate" title={c.title}>{c.title}</span>
                          </span>
                          <span className="block mt-0.5 text-2xs text-text-disabled">
                            {relative(c.updated_at)}
                          </span>
                        </button>
                        <ConversationActions conv={c} side="bottom" align="end" />
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
