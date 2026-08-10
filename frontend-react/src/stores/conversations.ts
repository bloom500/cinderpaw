import { create } from 'zustand';
import { tauri, type PersistedMessage, type ConversationSummary } from '@/lib/tauri';
import { rehydrateLiveSession } from '@/lib/feralLiveSession';
import { voiceToPersisted, voiceFromPersisted } from '@/lib/messageMapping';
import { useChat, type ChatMessage } from './chat';

export type { ConversationSummary };

interface ConversationsStore {
  list: ConversationSummary[];
  currentId: string | null;
  loadingConversation: boolean;
  /**
   * Session IDs that are currently mid-stream — i.e. the user sent a
   * message and the model is still generating a response. Used by the
   * sidebar to show a spinner next to the chat so the user can track
   * ongoing generations even when they switch tabs.
   *
   * Stored as a plain object (Record) instead of a Set so Zustand
   * re-renders subscribers on add/remove — Sets don't trigger
   * shallow-equality updates.
   */
  streamingIds: Record<string, true>;

  refresh:     () => Promise<void>;
  open:        (id: string) => Promise<void>;
  /** `agentId` tags the conversation as agent-owned (Agents tab); omit for chat. */
  saveCurrent: (title: string, agentId?: string | null) => Promise<void>;
  delete:      (id: string) => Promise<void>;
  newChat:     () => void;
  markStreaming:   (id: string) => void;
  unmarkStreaming: (id: string) => void;
}

function toChatMessage(p: PersistedMessage, idx: number): ChatMessage {
  return {
    id: `msg-${idx}-${Date.now()}`,
    role: p.role === 'user' ? 'user' : 'assistant',
    content: p.content,
    thinking: p.thinking,
    thinkingComplete: p.thinking != null ? true : undefined,
    voice: voiceFromPersisted(p.voice),
    // `?? undefined` because the store's field is optional while the wire type
    // is nullable — a literal null would render as a present-but-empty stat.
    scratch: p.scratch ?? undefined,
    createdAt: Date.now() - (1000 * (1000 - idx)),
  };
}

function toPersisted(m: ChatMessage): PersistedMessage {
  // Every save path must carry `scratch`, not just the one in useFeral: this one
  // runs on rename and on delete-a-message, and dropping the field there would
  // erase the trace on an edit that has nothing to do with it.
  return {
    role: m.role,
    content: m.content,
    thinking: m.thinking || undefined,
    voice: voiceToPersisted(m.voice),
    scratch: m.scratch,
  };
}

export const useConversations = create<ConversationsStore>((set, get) => ({
  list: [],
  currentId: null,
  loadingConversation: false,
  streamingIds: {},

  refresh: async () => {
    try {
      const list = await tauri.conversations.list();
      list.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      set({ list });
    } catch (err) {
      // Don't let a failed list read leave the UI in an inconsistent state.
      console.error('[conversations] refresh failed:', err);
    }
  },

  open: async (id) => {
    // If this session is already resident in memory and still streaming,
    // skip the disk load entirely — the in-memory buffer is more complete
    // than the initial disk snapshot and overwriting it would cause a
    // visible flash or loss of already-streamed tokens.
    const alreadyLive =
      useChat.getState().sessionId === id && Boolean(get().streamingIds[id]);
    if (alreadyLive) {
      set({ currentId: id });
      return;
    }

    set({ loadingConversation: true });
    try {
      const conv = await tauri.conversations.load(id);
      const msgs = conv.messages.map(toChatMessage);
      // Preserve the streaming animation if the user re-enters the chat
      // that's currently mid-generation. Without this, `loadSession` would
      // reset `streamStatus` to 'idle' and the spinner / streaming indicator
      // would vanish the moment the user clicked the in-flight conversation
      // in the sidebar.
      const isStreaming = Boolean(get().streamingIds[id]);
      useChat.getState().loadSession(conv.id, msgs, isStreaming ? 'streaming' : 'idle');
      // The disk snapshot is stale while a generation is in flight — restore
      // streamed content, tool bubbles and agent phase from the live mirror
      // so the task doesn't look like it reset.
      if (isStreaming) rehydrateLiveSession(id);
      set({ currentId: id });
    } finally {
      set({ loadingConversation: false });
    }
  },

  saveCurrent: async (title, agentId) => {
    const chat = useChat.getState();
    const persisted = chat.messages.map(toPersisted);
    try {
      await tauri.conversations.save(chat.sessionId, title, persisted, agentId);
      set({ currentId: chat.sessionId });
    } catch (err) {
      console.error('[conversations] save failed:', err);
      throw err;
    } finally {
      // Always refresh — even if the save itself threw, the user may have
      // partially-updated state we should reconcile with disk.
      await get().refresh();
    }
  },

  delete: async (id) => {
    await tauri.conversations.delete(id);
    if (get().currentId === id) {
      useChat.getState().newSession();
      set({ currentId: null });
    }
    // If the deleted chat was mid-stream, clear the flag too.
    if (get().streamingIds[id]) {
      const next = { ...get().streamingIds };
      delete next[id];
      set({ streamingIds: next });
    }
    await get().refresh();
  },

  newChat: () => {
    useChat.getState().newSession();
    set({ currentId: null });
  },

  markStreaming: (id) => {
    if (get().streamingIds[id]) return;
    set({ streamingIds: { ...get().streamingIds, [id]: true } });
  },

  unmarkStreaming: (id) => {
    if (!get().streamingIds[id]) return;
    const next = { ...get().streamingIds };
    delete next[id];
    set({ streamingIds: next });
  },
}));
