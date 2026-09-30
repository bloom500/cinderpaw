import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { StreamErrorNotice } from '../StreamErrorNotice';
import { useChat } from '@/stores/chat';
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
  });
});
