import { create } from 'zustand';

export type StreamStatus = 'idle' | 'streaming' | 'done' | 'error' | 'stopped';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  thinkingStartAt?: number;
  thinkingDurationMs?: number;
  thinkingComplete?: boolean;
  createdAt: number;
}

interface ChatStore {
  sessionId: string;
  messages: ChatMessage[];
  streamStatus: StreamStatus;
  streamError: string | null;
  expandedThinkingIds: Record<string, boolean>;

  newSession: () => void;
  loadSession: (sessionId: string, messages: ChatMessage[]) => void;
  addMessage: (m: ChatMessage) => void;
  appendToStreamingAssistant: (text: string) => void;
  updateLastAssistantMessage: (patch: Partial<ChatMessage>) => void;
  setStreamStatus: (s: StreamStatus, err?: string | null) => void;
  toggleThinking: (id: string) => void;
}

export const useChat = create<ChatStore>((set) => ({
  sessionId: crypto.randomUUID(),
  messages: [],
  streamStatus: 'idle',
  streamError: null,
  expandedThinkingIds: {},

  newSession: () =>
    set({
      sessionId: crypto.randomUUID(),
      messages: [],
      streamStatus: 'idle',
      streamError: null,
      expandedThinkingIds: {},
    }),

  loadSession: (sessionId, messages) =>
    set({ sessionId, messages, streamStatus: 'idle', streamError: null, expandedThinkingIds: {} }),

  addMessage: (m) => set((s) => ({ messages: [...s.messages, m] })),

  appendToStreamingAssistant: (text) =>
    set((s) => {
      if (s.messages.length === 0) return s;
      const last = s.messages[s.messages.length - 1];
      if (last.role !== 'assistant') return s;
      return { messages: [...s.messages.slice(0, -1), { ...last, content: last.content + text }] };
    }),

  updateLastAssistantMessage: (patch) =>
    set((s) => {
      if (s.messages.length === 0) return s;
      const last = s.messages[s.messages.length - 1];
      if (last.role !== 'assistant') return s;
      return { messages: [...s.messages.slice(0, -1), { ...last, ...patch }] };
    }),

  setStreamStatus: (streamStatus, err = null) =>
    set({ streamStatus, streamError: err ?? null }),

  toggleThinking: (id) =>
    set((s) => ({
      expandedThinkingIds: { ...s.expandedThinkingIds, [id]: !s.expandedThinkingIds[id] },
    })),
}));
