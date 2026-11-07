import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const send = vi.fn(async () => {});
vi.mock('@/hooks/useCinderpaw', () => ({ useCinderpawSendMessage: () => send }));

import { useResendTurn } from '../useResendTurn';
import { useChat, type ChatMessage } from '@/stores/chat';
import { useNotifications } from '@/stores/notifications';

const msg = (id: string, role: 'user' | 'assistant', content: string) => ({ id, role, content, createdAt: 0 }) as ChatMessage;

describe('useResendTurn', () => {
  beforeEach(() => {
    send.mockClear();
    useChat.setState({ messages: [msg('1', 'user', 'first'), msg('2', 'assistant', 'a'), msg('3', 'user', 'second'), msg('4', 'assistant', 'b')] });
  });

  it('retrying the last reply goes at once', async () => {
    const { result } = renderHook(() => useResendTurn());
    await result.current(3);
    expect(send).toHaveBeenCalledWith('second', undefined);
  });

  it('redoing an older turn asks first, with the count, and only its button resends', async () => {
    const push = vi.spyOn(useNotifications.getState(), 'push');
    const { result } = renderHook(() => useResendTurn());
    await result.current(0, 'first, edited');
    expect(send).not.toHaveBeenCalled();
    expect(useChat.getState().messages).toHaveLength(4);
    const [, title, , action] = push.mock.calls.at(-1)!;
    expect(title).toBe('This removes the reply after it');
    action!.run();
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('first, edited', undefined));
  });
});
