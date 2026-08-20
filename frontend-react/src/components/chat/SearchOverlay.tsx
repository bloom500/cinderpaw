import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, X, Folder } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useUI } from '@/stores/ui';
import { useConversations, type ConversationSummary } from '@/stores/conversations';
import { useProjects, type Project } from '@/stores/projects';
import { tauri, type Conversation } from '@/lib/tauri';
import { ConversationActions, ProjectActions } from '@/components/items/ItemActions';

/**
 * One row. Two kinds, because Search is where the sidebar's conversation list
 * and project tree are both moving — a field that finds only chats cannot be
 * the thing that replaces a rail containing both.
 *
 * They stay one FLAT array despite being rendered in groups, so arrow keys and
 * Enter keep working across the whole list without a second index to reconcile.
 */
type SearchResult =
  | { kind: 'project'; project: Project; chatCount: number }
  | { kind: 'conversation'; conv: ConversationSummary; snippet: string | null };

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
  const allProjects = useProjects((s) => s.list);

  const [query, setQuery]     = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  // #21: index of the keyboard-highlighted result (-1 = none).
  const [activeIdx, setActiveIdx] = useState(-1);
  // Non-null while results are narrowed to one project. It can start narrowed:
  // opening search from a Home project card means the project is already the
  // question, so re-picking it would be busywork.
  const [scope, setScope] = useState<Project | null>(
    () => useProjects.getState().list.find((p) => p.id === useUI.getState().searchScopeId) ?? null,
  );
  const inputRef              = useRef<HTMLInputElement>(null);
  const cacheRef              = useRef<Map<string, Conversation>>(new Map());
  const debounceRef           = useRef<ReturnType<typeof setTimeout> | null>(null);

  // #21: focus the input on open and RESTORE focus to whatever had it
  // before the overlay opened (keyboard users otherwise lose their place).
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => prev?.focus?.();
  }, []);

  // #21: Escape closes from anywhere in the overlay, not only while the
  // input has focus (e.g. after tabbing to a result).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') closeSearch();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [closeSearch]);

  const runSearch = useCallback(async (q: string) => {
    if (!q.trim()) { setResults([]); return; }
    const lower = q.toLowerCase();

    // Projects first: a project is the coarser answer, so it belongs above the
    // individual chats inside it.
    const projectMatches = allProjects
      .filter((p) => p.name.toLowerCase().includes(lower))
      .map((p): SearchResult => ({
        kind: 'project',
        project: p,
        chatCount: p.conversation_ids.length,
      }));

    // Immediate title matches
    const titleMatches = allConvs
      .filter((c) => c.title.toLowerCase().includes(lower))
      .map((c) => ({ kind: 'conversation' as const, conv: c, snippet: null }));
    setResults([...projectMatches, ...titleMatches]);

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
    const final: SearchResult[] = [...projectMatches, ...titleMatches];

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
          final.push({ kind: 'conversation', conv: c, snippet: snip });
          break;
        }
      }
    }
    setResults(final);
  }, [allConvs, allProjects]);

  /**
   * Results actually rendered. Inside a project scope only its conversations
   * survive, and project rows are dropped — you are already in one.
   */
  const visible = (() => {
    // Nothing typed, no project picked: the answer is what you have, newest
    // first. Search is where the rail's conversation list went, and a list you
    // can only see by naming the thing you want is not a list — it is a quiz.
    // Browsing and finding are the same field: type to narrow, type nothing to
    // see everything.
    if (!scope && !query.trim()) {
      const projects = allProjects
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p): SearchResult => ({
          kind: 'project', project: p, chatCount: p.conversation_ids.length,
        }));
      const convs = allConvs
        .slice()
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
        .map((conv): SearchResult => ({ kind: 'conversation', conv, snippet: null }));
      return [...projects, ...convs];
    }
    if (!scope) return results;
    // Inside a project with nothing typed yet, the answer is what the project
    // CONTAINS. Filtering an empty search would report "nothing matches" about
    // a question the user never asked — which is how opening a project from
    // Home used to greet them.
    if (!query.trim()) {
      return allConvs
        .filter((c) => scope.conversation_ids.includes(c.id))
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
        .map((conv): SearchResult => ({ kind: 'conversation', conv, snippet: null }));
    }
    return results.filter(
      (r) => r.kind === 'conversation' && scope.conversation_ids.includes(r.conv.id),
    );
  })();

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { void runSearch(query); }, 150);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, runSearch]);

  /**
   * Selecting a project SCOPES the search to it rather than navigating.
   *
   * There is no project page to navigate to, and opening a project's newest
   * chat would be a guess dressed up as an answer. A project is a container,
   * so the honest response to picking one is to show what is inside it.
   */
  const handleSelect = async (r: SearchResult) => {
    if (r.kind === 'project') {
      setScope(r.project);
      setActiveIdx(-1);
      inputRef.current?.focus();
      return;
    }
    closeSearch();
    navigate('/chat');
    await convOpen(r.conv.id);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Search chats and projects"
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
            onChange={(e) => { setQuery(e.target.value); setActiveIdx(-1); }}
            // #21: arrow keys move through results, Enter opens the
            // highlighted one (or the first when none is highlighted).
            onKeyDown={(e) => {
              // Escape backs out of a project before closing the whole
              // overlay — otherwise narrowing to a project is a one-way door
              // and the only way out is to reopen search.
              if (e.key === 'Escape') {
                if (scope) { setScope(null); setActiveIdx(-1); }
                else closeSearch();
              }
              else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveIdx((i) => Math.min(i + 1, visible.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIdx((i) => Math.max(i - 1, -1));
              } else if (e.key === 'Enter' && visible.length > 0) {
                e.preventDefault();
                void handleSelect(visible[Math.max(activeIdx, 0)]);
              }
            }}
            role="combobox"
            aria-expanded={query.trim().length > 0}
            aria-controls="search-results"
            aria-activedescendant={activeIdx >= 0 ? `search-result-${activeIdx}` : undefined}
            placeholder={scope ? `Search in ${scope.name}…` : 'Search chats and projects…'}
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

        {/* Scope chip — a filter you cannot see is a filter you cannot undo. */}
        {scope && (
          <div className="mt-2 flex items-center gap-2 text-xs text-text-muted">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border-default bg-bg-surface px-2.5 py-1">
              <Folder size={11} aria-hidden />
              <span className="text-text-secondary">{scope.name}</span>
              <button
                type="button"
                onClick={() => { setScope(null); setActiveIdx(-1); }}
                aria-label={`Search everything instead of ${scope.name}`}
                className="ml-0.5 rounded-full p-0.5 hover:bg-bg-hover hover:text-text-secondary"
              >
                <X size={11} />
              </button>
            </span>
          </div>
        )}

        {/* Results. Always rendered: with an empty field this is the browse
            list, and on a fresh install it is the one honest line saying so. */}
        {(
          <div
            id="search-results"
            role="listbox"
            className="mt-2 bg-bg-surface border border-bg-hover rounded-2xl overflow-hidden shadow-xl max-h-[60vh] overflow-y-auto"
          >
            {!scope && !query.trim() && visible.length > 0 && (
              <div className="px-4 pt-3 pb-1 text-2xs uppercase tracking-wide text-text-disabled">
                Recent
              </div>
            )}
            {visible.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-text-disabled">
                {/* Name what was searched. "No matches" alone leaves the user
                    guessing whether the thing they want is even searchable. */}
                {scope
                  ? (query.trim()
                      ? `Nothing in ${scope.name} matches.`
                      : `${scope.name} has no conversations yet.`)
                  : query.trim()
                    ? 'No conversations or projects match.'
                    : 'No conversations yet. Ask Feral something and it will show up here.'}
              </div>
            ) : (
              visible.map((r, i) => (
                <div
                  key={r.kind === 'project' ? `p:${r.project.id}` : `c:${r.conv.id}`}
                  // Presentational so the option stays the listbox's child as
                  // far as assistive tech is concerned; the row is only layout.
                  role="presentation"
                  className={`group flex items-center gap-1 pr-2 hover:bg-bg-hover transition-colors border-b border-bg-hover last:border-0 ${i === activeIdx ? 'bg-bg-hover' : ''}`}
                >
                <button
                  id={`search-result-${i}`}
                  type="button"
                  role="option"
                  aria-selected={i === activeIdx}
                  onClick={() => { void handleSelect(r); }}
                  className="flex-1 min-w-0 text-left px-4 py-3"
                >
                  {r.kind === 'project' ? (
                    <>
                      <div className="flex items-center gap-2 text-sm font-medium text-text-primary truncate">
                        <Folder size={14} className="shrink-0 text-text-muted" aria-hidden />
                        {highlight(r.project.name, query)}
                      </div>
                      <div className="text-2xs text-text-disabled mt-0.5">
                        Project · {r.chatCount} {r.chatCount === 1 ? 'chat' : 'chats'}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="text-sm font-medium text-text-primary truncate">
                        {highlight(r.conv.title, query)}
                      </div>
                      {r.snippet && (
                        <div className="text-xs text-text-muted mt-0.5 line-clamp-2">
                          {highlight(r.snippet, query)}
                        </div>
                      )}
                      <div className="text-2xs text-text-disabled mt-0.5">
                        {relativeTime(r.conv.updated_at)}
                      </div>
                    </>
                  )}
                </button>

                  {/* Same actions as the sidebar row, on the same item. A chat
                      you can find but not rename, move, or delete would make
                      Search a weaker home than the rail it replaces. */}
                  {r.kind === 'project'
                    ? <ProjectActions project={r.project} side="bottom" align="end" />
                    : <ConversationActions conv={r.conv} side="bottom" align="end" />}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
