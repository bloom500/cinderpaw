import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { TopNav } from '../TopNav';
import { useUI } from '@/stores/ui';

const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

/**
 * The contract allows the persistent chrome exactly four items and a settings
 * affordance. The count is the point: a rail grew to nine one reasonable
 * addition at a time, and nothing failed when it did.
 */
describe('TopNav', () => {
  beforeEach(() => {
    navigate.mockReset();
    useUI.setState({ searchOpen: false });
  });

  const mount = () => render(<MemoryRouter><TopNav /></MemoryRouter>);

  it('offers New, Models, Search and Settings, and nothing else', () => {
    mount();
    for (const label of ['New', 'Models', 'Search']) {
      expect(screen.getByText(label, { selector: 'span' })).toBeTruthy();
    }
    // Settings is the icon-only affordance, so it is reachable by name only if
    // someone remembered the aria-label.
    expect(screen.getByLabelText('Settings')).toBeTruthy();
    // Everything clickable in the nav, wordmark excluded.
    const buttons = screen.getByRole('navigation').querySelectorAll('button');
    expect(buttons.length).toBe(4);
  });

  it('+ New offers both a chat and a project', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByText('New', { selector: 'span' }));
    expect(await screen.findByText('New chat')).toBeTruthy();
    expect(screen.getByText('New project')).toBeTruthy();
  });

  it('a new chat navigates and tells the page to start one', async () => {
    const user = userEvent.setup();
    const started = vi.fn();
    window.addEventListener('feral:new-chat', started);
    mount();
    await user.click(screen.getByText('New', { selector: 'span' }));
    await user.click(await screen.findByText('New chat'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/chat'));
    // Navigating alone leaves the previous conversation on screen; the event is
    // what actually empties it.
    expect(started).toHaveBeenCalled();
    window.removeEventListener('feral:new-chat', started);
  });

  it('Search opens the overlay rather than navigating somewhere', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByText('Search', { selector: 'span' }));
    expect(useUI.getState().searchOpen).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('Settings and Models go to their pages', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByText('Models', { selector: 'span' }));
    expect(navigate).toHaveBeenCalledWith('/models');
    await user.click(screen.getByLabelText('Settings'));
    expect(navigate).toHaveBeenCalledWith('/settings');
  });
});
