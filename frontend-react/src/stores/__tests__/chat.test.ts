import { describe, it, expect, beforeEach } from 'vitest';
import { useChat } from '@/stores/chat';

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
});
