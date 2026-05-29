// STUB — full implementation in Phase D (Task D4).
// Just enough shape so Sidebar and ChatPage can compile.
import { create } from 'zustand';

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

interface ConversationsStore {
  list: ConversationSummary[];
  currentId: string | null;
  loadingConversation: boolean;
  refresh: () => Promise<void>;
  open: (id: string) => Promise<void>;
  saveCurrent: (title: string) => Promise<void>;
  delete: (id: string) => Promise<void>;
  newChat: () => void;
}

export const useConversations = create<ConversationsStore>(() => ({
  list: [],
  currentId: null,
  loadingConversation: false,
  refresh: async () => {},
  open: async () => {},
  saveCurrent: async () => {},
  delete: async () => {},
  newChat: () => {},
}));
