import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useChat } from '@/stores/chat';

// The approval verdict must reach the sidecar; in tests there is no Tauri
// runtime, so stub the one call this suite exercises and let everything
// else through untouched.
vi.mock('@/lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tauri')>();
  return {
    ...actual,
    tauri: {
      ...actual.tauri,
      cinderpawAgent: {
        ...actual.tauri.cinderpawAgent,
        coworkApprovalResolve: vi.fn().mockResolvedValue(undefined),
      },
    },
  };
});

const reset = () =>
  useChat.setState({
    sessionId: 'test-session',
    messages: [],
    streamStatus: 'idle',
    streamError: null,
    expandedThinkingIds: {},
    toolCallStream: [],
    lastCompletionStopped: false,
  });

describe('useChat', () => {
  beforeEach(reset);

  it('addMessage appends to messages', () => {
    useChat.getState().addMessage({ id: '1', role: 'user', content: 'hi', createdAt: 0 });
    expect(useChat.getState().messages).toHaveLength(1);
  });

  it('appendToStreamingAssistant appends only to last assistant message', () => {
    const s = useChat.getState();
    s.addMessage({ id: '1', role: 'user', content: 'q', createdAt: 0 });
    s.addMessage({ id: '2', role: 'assistant', content: '', createdAt: 1 });
    s.appendToStreamingAssistant('Hello ');
    s.appendToStreamingAssistant('world');
    const msgs = useChat.getState().messages;
    expect(msgs[0].content).toBe('q');
    expect(msgs[1].content).toBe('Hello world');
  });

  it('toggleThinking toggles the boolean (Record, not Set)', () => {
    useChat.getState().toggleThinking('msg-1');
    expect(useChat.getState().expandedThinkingIds['msg-1']).toBe(true);
    useChat.getState().toggleThinking('msg-1');
    expect(useChat.getState().expandedThinkingIds['msg-1']).toBe(false);
  });

  it('toggleThinking creates a new object reference (referential equality safe)', () => {
    const before = useChat.getState().expandedThinkingIds;
    useChat.getState().toggleThinking('m1');
    expect(useChat.getState().expandedThinkingIds).not.toBe(before);
  });

  it('newSession assigns a new sessionId and clears messages', () => {
    useChat.getState().addMessage({ id: '1', role: 'user', content: 'x', createdAt: 0 });
    const oldId = useChat.getState().sessionId;
    useChat.getState().newSession();
    expect(useChat.getState().sessionId).not.toBe(oldId);
    expect(useChat.getState().messages).toEqual([]);
  });

  // patchMessage is what the ask_user flow uses to attach the question
  // card to a specific assistant message (instead of "the last one",
  // which races with tab switches). Locking the contract here.
  it('patchMessage updates the matching message and leaves siblings alone', () => {
    const s = useChat.getState();
    s.addMessage({ id: 'u1', role: 'user', content: 'q', createdAt: 0 });
    s.addMessage({ id: 'a1', role: 'assistant', content: 'partial', createdAt: 1 });
    s.addMessage({ id: 'a2', role: 'assistant', content: 'other', createdAt: 2 });
    s.patchMessage('a1', { askUser: { requestId: 'r1', sessionId: 's', questions: [] } });
    const msgs = useChat.getState().messages;
    expect(msgs[0].content).toBe('q');
    expect(msgs[1].askUser?.requestId).toBe('r1');
    expect(msgs[2].askUser).toBeUndefined();
    expect(msgs[1].content).toBe('partial'); // patch does not touch other fields
  });

  it('patchMessage is a no-op when the id is not in the current session', () => {
    const s = useChat.getState();
    s.addMessage({ id: 'a1', role: 'assistant', content: 'x', createdAt: 0 });
    const before = useChat.getState().messages;
    s.patchMessage('from-another-session', { askUser: undefined });
    expect(useChat.getState().messages).toBe(before);
  });

  it('patchMessage can clear askUser by passing undefined', () => {
    const s = useChat.getState();
    s.addMessage({ id: 'a1', role: 'assistant', content: 'x', createdAt: 0 });
    s.patchMessage('a1', { askUser: { requestId: 'r1', sessionId: 's', questions: [] } });
    expect(useChat.getState().messages[0].askUser?.requestId).toBe('r1');
    s.patchMessage('a1', { askUser: undefined });
    expect(useChat.getState().messages[0].askUser).toBeUndefined();
  });

  // ----- toolCallStream (Phase 4 — mascot tool-call strip) -----

  it('pushToolCall appends and caps at 4 entries (oldest first out)', () => {
    const s = useChat.getState();
    s.pushToolCall({ kind: 'tool', name: 'a', emoji: '🔧', mainArg: null, status: 'running' });
    s.pushToolCall({ kind: 'tool', name: 'b', emoji: '🔧', mainArg: null, status: 'running' });
    s.pushToolCall({ kind: 'tool', name: 'c', emoji: '🔧', mainArg: null, status: 'running' });
    s.pushToolCall({ kind: 'tool', name: 'd', emoji: '🔧', mainArg: null, status: 'running' });
    s.pushToolCall({ kind: 'tool', name: 'e', emoji: '🔧', mainArg: null, status: 'running' });

    const stream = useChat.getState().toolCallStream;
    expect(stream).toHaveLength(4);
    expect(stream.map((e) => (e as { name: string }).name)).toEqual(['b', 'c', 'd', 'e']);
  });

  it('completeToolCall flips the matching entry to done', () => {
    const s = useChat.getState();
    s.pushToolCall({ kind: 'tool', name: 'x', emoji: '🔧', mainArg: null, status: 'running' });
    const id = useChat.getState().toolCallStream[0].id;
    s.completeToolCall(id, { ok: true });

    const entry = useChat.getState().toolCallStream[0] as Extract<typeof s.toolCallStream[0], { kind: 'tool' }>;
    expect(entry.status).toBe('done');
    expect(entry.endedAt).not.toBeNull();
  });

  it('clearToolCallStream empties the array', () => {
    useChat.getState().pushToolCall({ kind: 'tool', name: 'x', emoji: '🔧', mainArg: null, status: 'running' });
    useChat.getState().clearToolCallStream();
    expect(useChat.getState().toolCallStream).toEqual([]);
  });

  /**
   * Background workers (`rlm()`). These differ from tool bubbles in one way
   * that decides whether the feature works at all: a worker is admitted
   * instantly and does all its work AFTER the turn ends, so its bubble has to
   * survive the post-turn wipe. Before this existed a worker had no UI at all
   * — a turn ended normally while two paid model loops ran on invisibly.
   */
  describe('worker bubbles', () => {
    type WorkerEvent = Parameters<ReturnType<typeof useChat.getState>['upsertWorker']>[0];
    const ev = (over: Partial<WorkerEvent> = {}): WorkerEvent => ({
      childId: 'sa-1',
      name: 'subagent-x-1',
      status: 'running',
      ...over,
    });

    it('creates one bubble and UPDATES it, never stacking duplicates', () => {
      const s = useChat.getState();
      s.upsertWorker(ev({ detail: 'starting' }));
      s.upsertWorker(ev({ detail: 'tool_start grep' }));
      const stream = useChat.getState().toolCallStream;
      expect(stream).toHaveLength(1);
      const w = stream[0] as Extract<(typeof stream)[0], { kind: 'worker' }>;
      expect(w.detail).toBe('tool_start grep');
      expect(w.status).toBe('running');
    });

    it('keeps the original startedAt across updates, so the timer is honest', () => {
      const s = useChat.getState();
      s.upsertWorker(ev());
      const started = (useChat.getState().toolCallStream[0] as { startedAt: number }).startedAt;
      s.upsertWorker(ev({ detail: 'later' }));
      expect((useChat.getState().toolCallStream[0] as { startedAt: number }).startedAt).toBe(started);
    });

    it('SURVIVES the post-turn wipe while running — the whole point', () => {
      const s = useChat.getState();
      s.pushToolCall({ kind: 'tool', name: 'x', emoji: '🔧', mainArg: null, status: 'running' });
      s.upsertWorker(ev());
      useChat.getState().clearToolCallStream();
      const stream = useChat.getState().toolCallStream;
      expect(stream).toHaveLength(1);
      expect(stream[0].kind).toBe('worker');
    });

    it('does not survive the wipe once it has settled', () => {
      const s = useChat.getState();
      s.upsertWorker(ev({ status: 'completed', detail: '3 tool call(s)' }));
      useChat.getState().clearToolCallStream();
      expect(useChat.getState().toolCallStream).toEqual([]);
    });

    it('keeps cancelled distinct from error', () => {
      // A worker the user stopped is not a worker that broke. Collapsing the
      // two is how a red badge stops meaning anything.
      const s = useChat.getState();
      s.upsertWorker(ev({ status: 'cancelled' }));
      expect((useChat.getState().toolCallStream[0] as { status: string }).status).toBe('cancelled');
      s.upsertWorker(ev({ childId: 'sa-2', status: 'error' }));
      expect((useChat.getState().toolCallStream[1] as { status: string }).status).toBe('error');
    });
  });

  describe('cowork approval bubbles (S4)', () => {
    type CoworkUpsert = Parameters<ReturnType<typeof useChat.getState>['upsertCoworkEvent']>[0];
    const approvalEvent = (over: Partial<CoworkUpsert> = {}): CoworkUpsert => ({
      key: 'approval:r1',
      title: '🔐 Shipper: Run command: rm -rf dist/',
      status: 'running',
      detail: 'Run command: rm -rf dist/',
      approval: {
        requestId: 'r1',
        approvalClass: 'delete',
        description: 'Run command: rm -rf dist/',
      },
      ...over,
    });
    const coworkBubble = () => {
      const stream = useChat.getState().toolCallStream;
      expect(stream).toHaveLength(1);
      return stream[0] as Extract<(typeof stream)[0], { kind: 'cowork' }>;
    };

    it('requested → approved is ONE bubble whose ask clears on terminal state', () => {
      useChat.getState().upsertCoworkEvent(approvalEvent());
      expect(coworkBubble().status).toBe('running');
      expect(coworkBubble().approval?.requestId).toBe('r1');

      useChat.getState().upsertCoworkEvent(approvalEvent({ status: 'done', detail: undefined, approval: undefined }));
      const b = coworkBubble();
      expect(b.status).toBe('done');
      // The buttons must not survive their own answer.
      expect(b.approval).toBeUndefined();
    });

    it('resolveCoworkApproval detaches the ask immediately and sends the verdict', async () => {
      const { tauri } = await import('@/lib/tauri');
      useChat.getState().upsertCoworkEvent(approvalEvent());

      useChat.getState().resolveCoworkApproval('r1', true);
      // Buttons are gone BEFORE any event round-trip — no double-click window.
      expect(coworkBubble().approval).toBeUndefined();
      expect(tauri.cinderpawAgent.coworkApprovalResolve).toHaveBeenCalledWith('r1', true);

      useChat.getState().resolveCoworkApproval('r2', false);
      expect(tauri.cinderpawAgent.coworkApprovalResolve).toHaveBeenCalledWith('r2', false);
    });
  });
});

/**
 * The bubble above the mascot that never went away.
 *
 * `completeToolCall` is what starts the linger timer that removes a finished
 * bubble, and it only runs on `tool_done`. Every way a turn can end WITHOUT
 * one — stopped, errored, sidecar gone mid-call — left the last bubble on
 * screen with a running clock until the app was restarted.
 */
describe('a turn that ends with a tool call still open', () => {
  beforeEach(() => {
    reset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const startCall = () =>
    useChat.getState().pushToolCall({
      kind: 'tool',
      name: 'read_file',
      emoji: '📄',
      mainArg: 'notes.md',
      status: 'running',
    });

  it.each(['stopped', 'error', 'done', 'idle'] as const)(
    'marks it cancelled and clears it — streamStatus %s',
    (status) => {
      startCall();
      expect(useChat.getState().toolCallStream).toHaveLength(1);

      useChat.getState().setStreamStatus(status);

      // Cancelled, not done: no result ever came back, and a ✓ would say one did.
      expect(useChat.getState().toolCallStream[0]).toMatchObject({
        status: 'cancelled',
      });
      expect(useChat.getState().toolCallStream[0]?.endedAt).toBeTypeOf('number');

      vi.advanceTimersByTime(4_000);
      expect(useChat.getState().toolCallStream).toEqual([]);
    },
  );

  it('leaves a running turn alone', () => {
    startCall();
    useChat.getState().setStreamStatus('streaming');
    expect(useChat.getState().toolCallStream[0]).toMatchObject({ status: 'running' });
  });

  it('does not touch a worker, which outlives the turn on purpose', () => {
    useChat.getState().upsertWorker({
      childId: 'w1',
      name: 'subagent-count-files',
      status: 'running',
      detail: 'counting',
    });
    useChat.getState().setStreamStatus('done');
    vi.advanceTimersByTime(4_000);
    const [w] = useChat.getState().toolCallStream;
    expect(w).toMatchObject({ kind: 'worker', status: 'running' });
  });
});
