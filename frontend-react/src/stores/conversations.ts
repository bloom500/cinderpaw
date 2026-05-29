import { create } from 'zustand';
import { tauri, type PersistedMessage, type ConversationSummary } from '@/lib/tauri';
import { useChat, type ChatMessage } from './chat';

export type { ConversationSummary };

interface ConversationsStore {
  list: ConversationSummary[];
  currentId: string | null;
  loadingConversation: boolean;

  refresh:     () => Promise<void>;
  open:        (id: string) => Promise<void>;
  saveCurrent: (title: string) => Promise<void>;
  delete:      (id: string) => Promise<void>;
  newChat:     () => void;
}

function toChatMessage(p: PersistedMessage, idx: number): ChatMessage {
  return {
    id: `msg-${idx}-${Date.now()}`,
    role: p.role === 'user' ? 'user' : 'assistant',
    content: p.content,
    createdAt: Date.now() - (1000 * (1000 - idx)),
  };
}

function toPersisted(m: ChatMessage): PersistedMessage {
  return { role: m.role, content: m.content };
}

export const useConversations = create<ConversationsStore>((set, get) => ({
  list: [],
  currentId: null,
  loadingConversation: false,

  refresh: async () => {
    const list = await tauri.conversations.list();
    set({ list });
  },

  open: async (id) => {
    set({ loadingConversation: true });
    try {
      const conv = await tauri.conversations.load(id);
      const msgs = conv.messages.map(toChatMessage);
      useChat.getState().loadSession(conv.id, msgs);
      set({ currentId: id });
    } finally {
      set({ loadingConversation: false });
    }
  },

  saveCurrent: async (title) => {
    const chat = useChat.getState();
    const persisted = chat.messages.map(toPersisted);
    await tauri.conversations.save(chat.sessionId, title, persisted);
    set({ currentId: chat.sessionId });
    await get().refresh();
  },

  delete: async (id) => {
    await tauri.conversations.delete(id);
    if (get().currentId === id) {
      useChat.getState().newSession();
      set({ currentId: null });
    }
    await get().refresh();
  },

  newChat: () => {
    useChat.getState().newSession();
    set({ currentId: null });
  },
}));
