import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ProviderWaitNotice, StreamErrorNotice } from '../StreamErrorNotice';
import { useChat } from '@/stores/chat';
import { useConversations } from '@/stores/conversations';
import { humanizeError } from '@/lib/humanizeError';

const resend = vi.fn();
vi.mock('@/hooks/useResendTurn', () => ({ useResendTurn: () => resend }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

const show = () => render(<MemoryRouter><StreamErrorNotice /></MemoryRouter>);

beforeEach(() => {
  resend.mockClear();
  useChat.setState({ streamStatus: 'error', streamError: 'stream stalled after 60s', messages: [] });
});

describe('StreamErrorNotice', () => {
  it('says what happened, that the message is safe, and tries again', async () => {
    show();
    expect(screen.getByText('The model stopped answering')).toBeTruthy();
    expect(screen.getByText(/Your message is safe, nothing was lost\./)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(resend).toHaveBeenCalledTimes(1);
  });

  it('keeps the technical text behind Show details', async () => {
    show();
    expect(screen.queryByText('stream stalled after 60s')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show details' }));
    expect(screen.getByText('stream stalled after 60s')).toBeTruthy();
  });

  it('offers the fix when there is one, and nothing when there is no error', () => {
    useChat.setState({ streamError: 'HTTP 401 unauthorized' });
    const { unmount } = show();
    expect(screen.getByRole('button', { name: 'Open Cloud Keys' })).toBeTruthy();
    unmount();
    useChat.setState({ streamStatus: 'idle' });
    show();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('every error has a heading, the unknown one too', () => {
    expect(humanizeError('something odd').title).toBe('Something went wrong');
    expect(humanizeError('ECONNREFUSED').title).toBe('Could not reach the model');
    // An address that cannot be reached is not an overloaded provider, even with a 502 on it.
    expect(humanizeError('HTTP 502: Unable to connect. Is the computer able to access the url?').title).toBe('Could not reach the model');
  });

  it('says a missing model is a missing model, not an overloaded provider', () => {
    const raw = 'inference endpoint http://127.0.0.1:11435/v1/chat/completions returned 503: {"error":{"message":"no model selected — choose one in Models","type":"model_not_ready"}}';
    const e = humanizeError(raw);
    expect(e.title).toBe('No model is chosen yet');
    expect(e.action).toBe('models');
    expect(humanizeError('HTTP 503 service unavailable').title).toBe('The provider had a problem');
  });
  it('is still there when the chat is opened again: the error is saved with the reply', () => {
    // Report item 17: switching chats and back left only a green check.
    useChat.setState({
      streamStatus: 'idle', streamError: null,
      messages: [
        { id: 'u', role: 'user', content: 'hi', createdAt: 0 },
        { id: 'a', role: 'assistant', content: '', createdAt: 1, ended: { kind: 'error', raw: 'HTTP 503 service unavailable' } },
      ],
    });
    show();
    expect(screen.getByText('The provider had a problem')).toBeTruthy();
  });
});

describe('ProviderWaitNotice', () => {
  it('keeps a background wait across navigation and stops ticking after expiry', () => {
    vi.useFakeTimers();
    useConversations.getState().markStreaming('waiting');
    useConversations.getState().setProviderWait('waiting', 30_000);
    useChat.setState({ sessionId: 'waiting', streamStatus: 'streaming' });
    const view = render(<ProviderWaitNotice />);
    expect(screen.getByText(/Trying again in 30 s/)).toBeTruthy();
    act(() => useChat.setState({ sessionId: 'elsewhere', streamStatus: 'idle' }));
    expect(screen.queryByRole('status')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(10_000);
      useChat.setState({ sessionId: 'waiting', streamStatus: 'streaming' });
    });
    expect(screen.getByText(/Trying again in 20 s/)).toBeTruthy();
    act(() => vi.advanceTimersByTime(21_000));
    expect(screen.queryByRole('status')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    view.unmount();
    vi.useRealTimers();
  });

  it('says the provider is busy and counts down to the next try', async () => {
    vi.useFakeTimers();
    const emit = ({ sessionId, waitMs }: { sessionId: string; waitMs: number }) => useConversations.getState().setProviderWait(sessionId, waitMs);
    useConversations.getState().markStreaming('s1');
    useConversations.getState().markStreaming('other');
    useChat.setState({ sessionId: 's1', streamStatus: 'streaming', streamError: null });
    render(<ProviderWaitNotice />);
    act(() => emit({ sessionId: 'other', waitMs: 30_000 }));
    expect(screen.queryByRole('status')).toBeNull();
    act(() => emit({ sessionId: 's1', waitMs: 30_000 }));
    expect(screen.getByText(/Trying again in 30 s/)).toBeTruthy();
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByText(/Trying again in 20 s/)).toBeTruthy();
    act(() => { vi.advanceTimersByTime(21_000); });
    expect(screen.queryByRole('status')).toBeNull();
    vi.useRealTimers();
  });
});
