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
  completedAt?: number;
  tokenCount?: number;
  tokensPerSec?: number;
  /** True if the model hit max_tokens before producing a natural stop. */
  truncated?: boolean;
  /** Why the response was truncated (e.g. "length"). */
  truncatedReason?: string;
}

interface ChatStore {
  sessionId: string;
  messages: ChatMessage[];
  streamStatus: StreamStatus;
  streamError: string | null;
  expandedThinkingIds: Record<string, boolean>;

  newSession: () => void;
  /**
   * Replace the in-memory session. If `streamStatus` is provided, it overrides
   * the default 'idle' reset — used by `useConversations.open` when the target
   * session is currently mid-generation, so the streaming indicator keeps
   * showing after the user re-enters the in-flight chat from the sidebar.
   */
  loadSession: (sessionId: string, messages: ChatMessage[], streamStatus?: StreamStatus) => void;
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

  loadSession: (sessionId, messages, streamStatus = 'idle') =>
    set({ sessionId, messages, streamStatus, streamError: null, expandedThinkingIds: {} }),

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
