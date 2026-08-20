import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useConversations } from '@/stores/conversations';
import { useUI } from '@/stores/ui';
import { ConversationActions } from '@/components/items/ItemActions';
import { cn } from '@/lib/utils';

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

export function ChatsPage() {
  const navigate = useNavigate();
  const list = useConversations((s) => s.list);
  const currentId = useConversations((s) => s.currentId);
  const streamingIds = useConversations((s) => s.streamingIds);
  const openSearch = useUI((s) => s.openSearch);

  const sorted = (list ?? [])
    .slice()
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div data-tauri-drag-region className="h-10 shrink-0" />
      <div className="flex-1 overflow-y-auto scrollbar-hide">
        <div className="max-w-3xl mx-auto px-6 pb-10">
          <div className="mb-6 flex items-baseline justify-between gap-4">
            <h1 className="text-2xl font-semibold text-text-primary tracking-tight">Chats</h1>
            {sorted.length > 0 && (
              <button
                type="button"
                onClick={() => openSearch()}
                className="text-sm text-text-muted hover:text-text-secondary cursor-pointer"
              >
                Search them
              </button>
            )}
          </div>

          {sorted.length === 0 ? (
            <p className="text-sm text-text-muted">
              No conversations yet. Ask Feral something and it will show up here.
            </p>
          ) : (
            <div className="space-y-1">
              {sorted.map((c) => (
                <div
                  key={c.id}
                  className={cn(
                    'group flex items-center gap-2 rounded-xl pr-2 transition-colors',
                    c.id === currentId ? 'bg-bg-active' : 'hover:bg-bg-hover',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => { void useConversations.getState().open(c.id); navigate('/chat'); }}
                    className="flex-1 min-w-0 text-left px-4 py-3 cursor-pointer"
                  >
                    <span className="flex items-center gap-2">
                      {streamingIds[c.id] && (
                        <Loader2 size={12} className="shrink-0 animate-spin text-brand" aria-label="Generating" />
                      )}
                      <span className="text-sm text-text-primary truncate">{c.title}</span>
                    </span>
                    <span className="block mt-0.5 text-[11px] text-text-disabled">
                      {relative(c.updated_at)}
                    </span>
                  </button>
                  <ConversationActions conv={c} side="bottom" align="end" />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
