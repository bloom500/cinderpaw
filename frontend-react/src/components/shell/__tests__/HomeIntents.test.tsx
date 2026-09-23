import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HomeIntents } from '../HomeIntents';
import { tauri } from '@/lib/tauri';

/**
 * Four, fixed, in this order. The rail grew from four items to nine one
 * reasonable addition at a time and nothing failed when it did; a list of
 * intents rots the same way, and the count is the only thing that catches it.
 */
describe('HomeIntents', () => {
  it('offers exactly four intents, in the order the contract names', () => {
    render(<HomeIntents onPick={() => {}} />);
    const labels = screen.getAllByRole('button').map((b) => b.textContent);
    expect(labels).toEqual(['Research', 'Create', 'Analyze', 'Automate']);
  });

  it('fills the composer and stops there', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<HomeIntents onPick={onPick} />);
    await user.click(screen.getByText('Research'));
    // A stem to continue, with the trailing space, not a whole sentence and not
    // a send: the product does not guess what the user meant to ask.
    expect(onPick).toHaveBeenCalledWith('Research ');
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  // A fresh install: nothing on disk, no key. The chips would lead to a message
  // nothing can answer, so the screen becomes the one-button setup instead.
  it('turns into the sign-in card when no model exists', async () => {
    vi.spyOn(tauri.models, 'list').mockResolvedValue([]);
    vi.spyOn(tauri.raw, 'getByokSettings').mockResolvedValue([]);
    render(<HomeIntents onPick={() => {}} />);
    expect(await screen.findByText('Sign in with OpenRouter')).toBeTruthy();
    expect(screen.queryByText('Research')).toBeNull();
    vi.restoreAllMocks();
  });
});
