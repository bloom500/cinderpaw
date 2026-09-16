import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MessageActions } from '../MessageActions';

const writeText = vi.fn(async (_text: string) => {});
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: (t: string) => writeText(t) }));

describe('MessageActions', () => {
  beforeEach(() => writeText.mockClear());

  it('copies the whole message text', async () => {
    render(<MessageActions text="the full reply" />);
    fireEvent.click(screen.getByLabelText('Copy'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('the full reply'));
    await waitFor(() => expect(screen.getByLabelText('Copied')).toBeTruthy());
  });

  // A reply that is only tool activity or an ask_user card has no text to copy,
  // and a button that copies an empty string is worse than no button.
  it('renders nothing for an empty message with nothing to retry', () => {
    const { container } = render(<MessageActions text="   " />);
    expect(container.innerHTML).toBe('');
  });

  it('offers edit and retry only when the caller can do them', () => {
    const { queryByLabelText, rerender } = render(<MessageActions text="hi" />);
    expect(queryByLabelText('Edit')).toBeNull();
    expect(queryByLabelText('Try again')).toBeNull();
    rerender(<MessageActions text="hi" onEdit={() => {}} onRetry={() => {}} />);
    expect(queryByLabelText('Edit')).not.toBeNull();
    expect(queryByLabelText('Try again')).not.toBeNull();
  });
});
