import { describe, it, expect, beforeEach } from 'vitest';
import { useChat } from '@/stores/chat';

const reset = () =>
  useChat.setState({
    sessionId: 'test-session',
    messages: [],
    streamStatus: 'idle',
    streamError: null,
    expandedThinkingIds: {},
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
});
