import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useChat } from '@/stores/chat';
import { useChatContext } from '../useChatContext';

describe('useChatContext', () => {
  it('keeps one snapshot while a reply streams words that add no file, link or memory', () => {
    useChat.setState({ messages: [
      { id: 'q', role: 'user', content: 'Plan my trip', createdAt: 1 },
      { id: 'a', role: 'assistant', content: 'Day one', createdAt: 2 },
    ] });
    let renders = 0;
    const { result } = renderHook(() => { renders += 1; return useChatContext(); });
    const first = result.current;
    const before = renders;

    act(() => useChat.getState().updateLastAssistantMessage({ content: 'Day one: Alfama' }));
    act(() => useChat.getState().updateLastAssistantMessage({ content: 'Day one: Alfama and Baixa' }));
    expect(result.current).toBe(first);
    expect(renders).toBe(before);

    act(() => useChat.getState().updateLastAssistantMessage({ memoryUsed: [{ kind: 'fact', text: 'Likes trams' }] }));
    expect(result.current).not.toBe(first);
    expect(result.current.memories).toEqual([{ kind: 'fact', text: 'Likes trams' }]);
  });
});
