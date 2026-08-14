import { create } from 'zustand';
import { tauri } from '@/lib/tauri';

export type StreamStatus = 'idle' | 'streaming' | 'done' | 'error' | 'stopped';
export type AgentPhase = 'thinking' | 'calling' | 'processing'
  | 'reading' | 'searching' | 'building' | 'writing' | null;

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /**
   * Image attachments as data URLs (paste / file picker). Sent to
   * vision-capable models alongside the text; kept in-memory for the
   * session so follow-up turns still include the pixels.
   */
  images?: string[];
  thinking?: string;
  thinkingStartAt?: number;
  thinkingDurationMs?: number;
  thinkingComplete?: boolean;
  createdAt: number;
  completedAt?: number;
  tokenCount?: number;
  tokensPerSec?: number;
  /**
   * True when `tokenCount` is our chars/4 guess rather than the provider's own
   * number (local models never report usage). The footer marks it with a `~`
   * so a number nobody can verify never looks like one somebody measured.
   */
  tokensEstimated?: boolean;
  /** True if the model hit max_tokens before producing a natural stop. */
  truncated?: boolean;
  /** Why the response was truncated (e.g. "length"). */
  truncatedReason?: string;
  /**
   * What the agent wrote in its OWN scratchpad (`~/.feral/workspace`) during
   * this turn. Absent when it wrote nothing there — the common case, and an
   * always-present "0 edits" row would train people to stop reading the line.
   *
   * Deliberately excludes writes to the user's project: those show up as file
   * changes they can already see in their editor and in git. This answers the
   * question those cannot — what the agent did in the scratch space nobody is
   * watching.
   */
  scratch?: { edits: number; added: number; removed: number };
  /**
   * Ask-user prompt attached to this message. Set when the Feral Agent
   * called the `ask_user` tool on this turn. `answers` is undefined while
   * the user is choosing and populated once they submit (or on cancel).
   */
  askUser?: {
    requestId: string;
    sessionId: string;
    questions: import('./askUser').AskUserQuestion[];
    answers?: import('./askUser').AskUserAnswer[];
  };
  /** Present when this user turn was recorded as a voice message. */
  voice?: { audioPath: string; durationMs: number; transcript: string; peaks: number[] };
  /**
   * True while a voice message's transcription is still running. The bubble is
   * added optimistically (instant playback + waveform) the moment recording is
   * sent, and `voice.transcript` is filled in once whisper finishes — this flag
   * drives the "transcribing…" placeholder in between.
   */
  voicePending?: boolean;
}

interface ChatStore {
  sessionId: string;
  messages: ChatMessage[];
  streamStatus: StreamStatus;
  streamError: string | null;
  expandedThinkingIds: Record<string, boolean>;
  agentPhase: AgentPhase;
  agentTool: string | null;
  /** Real prompt token count from the last generation start (local: llama.cpp, cloud: API usage). */
  livePromptTokens: number | null;
  /** Real completion token count from the last cloud generation (undefined for local). */
  liveCompletionTokens: number | null;

  /**
   * Rolling list of tool calls + skill context bubbles displayed on the
   * mascot. Capped at 4 entries (oldest first out). Tool entries are
   * pushed on `tool_start` and flipped to `done`/`error` on `tool_done`;
   * context entries are pushed when the host pre-loads skills via
   * `skillsContext`. Cleared 5s after the `done` event.
   */
  toolCallStream: ToolCallEvent[];
  /**
   * Whether the most recent completion ended via user-initiated stop
   * (true) or natural completion (false). Lets the UI distinguish the
   * two in the post-done footer without re-parsing the last event.
   */
  lastCompletionStopped: boolean;

  /**
   * Thumbs 👍/👎 the user gave each assistant message, keyed by message id.
   * In-memory courtesy state so the buttons show which vote is active; the
   * durable record is the audit "feedback" row the sidecar writes (the
   * §2.10 `acceptance` personal-fitness signal). Reset per session.
   */
  feedback: Record<string, 'up' | 'down'>;

  newSession: () => void;
  /**
   * Replace the in-memory session. If `streamStatus` is provided, it overrides
   * the default 'idle' reset — used by `useConversations.open` when the target
   * session is currently mid-generation, so the streaming indicator keeps
   * showing after the user re-enters the in-flight chat from the sidebar.
   */
  loadSession: (sessionId: string, messages: ChatMessage[], streamStatus?: StreamStatus) => void;
  addMessage: (m: ChatMessage) => void;
  /** Record (or toggle off) the user's thumbs on an assistant message and
   *  forward it to the sidecar's audit log. */
  setFeedback: (messageId: string, value: 'up' | 'down') => void;
  /** Remove a message by id. Used to drop an optimistic voice bubble when its
   *  transcription fails before any reply was generated. */
  removeMessage: (id: string) => void;
  appendToStreamingAssistant: (text: string) => void;
  updateLastAssistantMessage: (patch: Partial<ChatMessage>) => void;
  /**
   * Patch a specific message (looked up by id) with a partial update. Used
   * by the ask_user flow to attach the question card to the exact assistant
   * message that triggered it — `updateLastAssistantMessage` would race
   * against concurrent streams and tab switches.
   */
  patchMessage: (id: string, patch: Partial<ChatMessage>) => void;
  setStreamStatus: (s: StreamStatus, err?: string | null) => void;
  setAgentPhase: (phase: AgentPhase, tool?: string | null) => void;
  toggleThinking: (id: string) => void;
  /** Clear streamed content of the last assistant message (called when a tool call is detected). */
  clearStreamingContent: () => void;
  setLiveTokens: (promptTokens: number, completionTokens?: number) => void;
  // ----- toolCallStream actions (Phase 4 — mascot tool-call strip) -----
  pushToolCall: (
    event: Omit<Extract<ToolCallEvent, { kind: 'tool' }>, 'id' | 'startedAt' | 'endedAt'>
      & { startedAt?: number },
  ) => string;
  completeToolCall: (id: string, result: { ok: boolean; error?: string; preview?: string }) => void;
  /** #18: attach a live progress/retry note to the most recent running tool. */
  noteToolProgress: (message: string) => void;
  pushSkillsContext: (names: string[]) => void;
  /**
   * Create or update a background worker's bubble from an `rlm_child` event.
   * One action rather than push/complete because the sidecar sends a stream of
   * updates keyed by the same childId, and the first one may arrive after the
   * turn that spawned it has already ended.
   */
  upsertWorker: (e: {
    childId: string;
    name: string;
    status: 'running' | 'completed' | 'error' | 'cancelled';
    detail?: string;
  }) => void;
  clearToolCallStream: () => void;
}

/**
 * One entry in the mascot's tool-call strip.
 *
 *  - "tool" entries are produced by `tool_start` / `tool_done` events.
 *  - "context" entries are produced by the host pre-loading skills via
 *    `skillsContext`; they have no running/done lifecycle and exist only
 *    to tell the user "the agent knows about these skills".
 */
export type ToolCallEvent =
  | {
      id: string;
      kind: 'tool';
      name: string;
      emoji: string;
      mainArg: string | null;
      status: 'running' | 'done' | 'error';
      startedAt: number;
      endedAt: number | null;
      /** #18: truncated tool output, expandable from the bubble. */
      resultPreview?: string | null;
      /** #18: error text when the tool failed. */
      errorMessage?: string | null;
      /** #18: live progress/retry note from `tool_progress` (e.g. "retry 2/3"). */
      progressNote?: string | null;
    }
  | {
      id: string;
      kind: 'context';
      label: string;
      startedAt: number;
      endedAt: number;
      status: 'done';
    }
  | {
      /** The ChildRegistry id — stable, so repeated events update one bubble. */
      id: string;
      kind: 'worker';
      /** Registry name, e.g. `subagent-count-the-files-a1b2`. */
      name: string;
      /** What it is doing right now, or why it ended. */
      detail: string | null;
      status: 'running' | 'done' | 'error' | 'cancelled';
      startedAt: number;
      endedAt: number | null;
    };

/** Hard cap on the number of bubbles the mascot renders at once. */
export const TOOL_CALL_STREAM_MAX = 4;

/** How long a finished tool bubble lingers before fading out on its own. */
export const TOOL_CALL_LINGER_MS = 4_000;

export const useChat = create<ChatStore>((set) => ({
  sessionId: crypto.randomUUID(),
  messages: [],
  streamStatus: 'idle',
  streamError: null,
  expandedThinkingIds: {},
  agentPhase: null,
  agentTool: null,
  livePromptTokens: null,
  liveCompletionTokens: null,
  toolCallStream: [],
  lastCompletionStopped: false,
  feedback: {},

  newSession: () =>
    set({
      sessionId: crypto.randomUUID(),
      messages: [],
      streamStatus: 'idle',
      streamError: null,
      expandedThinkingIds: {},
      agentPhase: null,
      agentTool: null,
      livePromptTokens: null,
      liveCompletionTokens: null,
      toolCallStream: [],
      lastCompletionStopped: false,
      feedback: {},
    }),

  loadSession: (sessionId, messages, streamStatus = 'idle') =>
    set({ sessionId, messages, streamStatus, streamError: null, expandedThinkingIds: {}, agentPhase: null, agentTool: null, livePromptTokens: null, liveCompletionTokens: null, toolCallStream: [], lastCompletionStopped: false, feedback: {} }),

  setFeedback: (messageId, value) =>
    set((s) => {
      // Toggle off if the same vote is clicked again; otherwise set/replace it.
      const current = s.feedback[messageId];
      const next = { ...s.feedback };
      if (current === value) delete next[messageId];
      else next[messageId] = value;
      // Forward every explicit click to the audit log (a re-click that toggles
      // the UI still tells the runtime the user's latest intent). Fire-and-
      // forget — the vote UI must not block on the sidecar.
      void tauri.raw.feralSubmitFeedback(s.sessionId, messageId, value).catch(() => {});
      return { feedback: next };
    }),

  addMessage: (m) => set((s) => ({ messages: [...s.messages, m] })),

  removeMessage: (id) => set((s) => ({ messages: s.messages.filter((m) => m.id !== id) })),

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

  patchMessage: (id, patch) =>
    set((s) => {
      // No-op when the target message is not in the current session's
      // message list — happens when the user switched to a different chat
      // mid-stream. The ask_user state lives in the original session's
      // message (in the conversations store / reloaded on next visit),
      // so dropping the patch here is safe.
      if (!s.messages.some((m) => m.id === id)) return s;
      return {
        messages: s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
      };
    }),

  setStreamStatus: (streamStatus, err = null) =>
    set((s) => ({
      streamStatus,
      streamError: err ?? null,
      agentPhase: streamStatus === 'idle' || streamStatus === 'done' || streamStatus === 'error' || streamStatus === 'stopped' ? null : s.agentPhase,
      agentTool: streamStatus === 'idle' || streamStatus === 'done' || streamStatus === 'error' || streamStatus === 'stopped' ? null : s.agentTool,
    })),

  setAgentPhase: (phase, tool = null) =>
    set({ agentPhase: phase, agentTool: tool ?? null }),

  toggleThinking: (id) =>
    set((s) => ({
      expandedThinkingIds: { ...s.expandedThinkingIds, [id]: !s.expandedThinkingIds[id] },
    })),

  clearStreamingContent: () =>
    set((s) => {
      if (s.messages.length === 0) return s;
      const last = s.messages[s.messages.length - 1];
      if (last.role !== 'assistant') return s;
      return { messages: [...s.messages.slice(0, -1), { ...last, content: '' }] };
    }),

  setLiveTokens: (promptTokens, completionTokens) =>
    set({ livePromptTokens: promptTokens, liveCompletionTokens: completionTokens ?? null }),

  // ----- toolCallStream actions -----

  pushToolCall: (event) => {
    const id = crypto.randomUUID();
    const startedAt = event.startedAt ?? Date.now();
    const full: ToolCallEvent = {
      ...event,
      id,
      startedAt,
      endedAt: null,
    } as ToolCallEvent;
    set((s) => {
      const next = [...s.toolCallStream, full];
      return { toolCallStream: next.length > TOOL_CALL_STREAM_MAX ? next.slice(-TOOL_CALL_STREAM_MAX) : next };
    });
    return id;
  },

  completeToolCall: (id, result) => {
    set((s) => ({
      toolCallStream: s.toolCallStream.map((e) =>
        e.id === id && e.kind === 'tool'
          ? {
              ...e,
              status: result.ok ? 'done' : 'error',
              endedAt: Date.now(),
              resultPreview: result.preview ?? null,
              errorMessage: result.error ?? null,
              progressNote: null,
            }
          : e,
      ),
    }));
    // Finished bubbles fade out on their own after a short linger instead of
    // piling up until the whole turn ends. AnimatePresence in ToolCallStack
    // plays the exit animation when the entry leaves the array.
    window.setTimeout(() => {
      set((s) => ({ toolCallStream: s.toolCallStream.filter((e) => e.id !== id) }));
    }, TOOL_CALL_LINGER_MS);
  },

  noteToolProgress: (message) => {
    set((s) => {
      const lastRunning = [...s.toolCallStream]
        .reverse()
        .find((e) => e.kind === 'tool' && e.status === 'running');
      if (!lastRunning) return s;
      return {
        toolCallStream: s.toolCallStream.map((e) =>
          e.id === lastRunning.id && e.kind === 'tool' ? { ...e, progressNote: message } : e,
        ),
      };
    });
  },

  pushSkillsContext: (names) => {
    if (names.length === 0) return;
    const id = crypto.randomUUID();
    const now = Date.now();
    const event: ToolCallEvent = {
      id,
      kind: 'context',
      label: `Skills: ${names.join(', ')}`,
      startedAt: now,
      endedAt: now,
      status: 'done',
    };
    set((s) => {
      const next = [...s.toolCallStream, event];
      return { toolCallStream: next.length > TOOL_CALL_STREAM_MAX ? next.slice(-TOOL_CALL_STREAM_MAX) : next };
    });
    // Context bubbles have no running lifecycle — fade them out too.
    window.setTimeout(() => {
      set((s) => ({ toolCallStream: s.toolCallStream.filter((e) => e.id !== id) }));
    }, TOOL_CALL_LINGER_MS);
  },

  upsertWorker: ({ childId, name, status, detail }) => {
    const done = status !== 'running';
    set((s) => {
      const existing = s.toolCallStream.find((e) => e.id === childId);
      const entry: ToolCallEvent = {
        id: childId,
        kind: 'worker',
        name,
        detail: detail ?? null,
        status: status === 'completed' ? 'done' : status,
        startedAt: existing?.startedAt ?? Date.now(),
        endedAt: done ? Date.now() : null,
      };
      const next = existing
        ? s.toolCallStream.map((e) => (e.id === childId ? entry : e))
        : [...s.toolCallStream, entry];
      return { toolCallStream: next.length > TOOL_CALL_STREAM_MAX ? next.slice(-TOOL_CALL_STREAM_MAX) : next };
    });
    // Only a settled worker fades. A running one has no known end — that is
    // the whole difference between a worker and a tool call.
    if (done) {
      window.setTimeout(() => {
        set((s) => ({ toolCallStream: s.toolCallStream.filter((e) => e.id !== childId) }));
      }, TOOL_CALL_LINGER_MS);
    }
  },

  // A running worker SURVIVES the clear. The stream is wiped 5s after the turn
  // ends, and a worker outliving its turn is the normal case, not the edge —
  // wiping it would hide exactly the work that has nothing else to show it.
  clearToolCallStream: () =>
    set((s) => ({
      toolCallStream: s.toolCallStream.filter((e) => e.kind === 'worker' && e.status === 'running'),
    })),

}));
