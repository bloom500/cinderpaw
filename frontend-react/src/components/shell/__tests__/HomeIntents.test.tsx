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
  it('offers exactly four intents, in the order the contract names, then the five suggestions', () => {
    render(<HomeIntents onPick={() => {}} />);
    const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(names).toEqual([
      'Research', 'Create', 'Analyze', 'Automate',
      'Plan my week', 'Summarize a PDF', 'Compare three laptops', 'Draft an email', 'Explain a topic simply',
    ]);
  });

  it('a suggestion fills the composer and stops there too', async () => {
    const onPick = vi.fn();
    render(<HomeIntents onPick={onPick} />);
    await userEvent.click(screen.getByRole('button', { name: 'Draft an email' }));
    expect(onPick).toHaveBeenCalledWith('Draft an email');
  });

  it('an intent opens five everyday jobs, and a job fills the composer and stops there', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<HomeIntents onPick={onPick} />);
    await user.click(screen.getByRole('button', { name: 'Automate' }));
    // Opening is not picking: a lone verb in the composer left people stuck.
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Automate' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Plan my week' })).toBeNull();
    const jobs = screen.getAllByRole('listitem');
    expect(jobs).toHaveLength(5);
    await user.click(screen.getByRole('button', { name: /Sort my Downloads folder/ }));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]![0]).toMatch(/^Sort my Downloads folder/);
    // A second click on the intent closes it, and the suggestions come back.
    await user.click(screen.getByRole('button', { name: 'Automate' }));
    expect(screen.getByRole('button', { name: 'Plan my week' })).toBeTruthy();
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
