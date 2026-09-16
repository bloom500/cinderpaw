import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MessageActions } from '../MessageActions';

const writeText = vi.fn(async () => {});
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: (t: string) => writeText(t) }));

describe('MessageActions', () => {
  beforeEach(() => writeText.mockClear());

  it('copies the whole message text', async () => {
    render(<MessageActions text="the full reply" />);
    fireEvent.click(screen.getByLabelText('Copy message'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('the full reply'));
    await waitFor(() => expect(screen.getByLabelText('Copied')).toBeTruthy());
  });

  // A reply that is only tool activity or an ask_user card has no text to copy,
  // and a button that copies an empty string is worse than no button.
  it('renders nothing for an empty message', () => {
    const { container } = render(<MessageActions text="   " />);
    expect(container.innerHTML).toBe('');
  });
});
