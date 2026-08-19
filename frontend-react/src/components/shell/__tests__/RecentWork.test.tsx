/**
 * Phase 4 S4 — Home answers "what was I doing", without becoming a second
 * conversation list. The cap is the design, so it is what gets tested.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { RecentWork } from '../RecentWork';
import { useConversations } from '@/stores/conversations';
import { useProjects } from '@/stores/projects';
import { useUI } from '@/stores/ui';

vi.mock('@/lib/tauri', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, tauri: { conversations: { load: vi.fn(async () => ({ messages: [] })) } } };
});

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function show() {
  return render(<MemoryRouter><RecentWork /></MemoryRouter>);
}

beforeEach(() => {
  useConversations.setState({ list: [], currentId: null, streamingIds: {} });
  useProjects.setState({ list: [] });
  useUI.setState({ searchOpen: false, searchScopeId: null });
});

describe('RecentWork', () => {
  it('renders nothing on a fresh install', () => {
    const { container } = show();
    expect(container.textContent).toBe('');
  });

  it('offers the most recent chat, and only that one', () => {
    useConversations.setState({
      list: [
        { id: 'c1', title: 'Older thing',  updated_at: iso(90 * 60_000) },
        { id: 'c2', title: 'Newest thing', updated_at: iso(5 * 60_000) },
        { id: 'c3', title: 'Ancient',      updated_at: iso(400 * 60_000) },
      ],
    });
    show();

    expect(screen.getByText('Newest thing')).toBeTruthy();
    // Home is not a second conversation list: the other two stay in Search.
    expect(screen.queryByText('Older thing')).toBeNull();
    expect(screen.queryByText('Ancient')).toBeNull();
  });

  it('picks the project whose newest chat is newest, and skips empty ones', () => {
    useConversations.setState({
      list: [
        { id: 'c1', title: 'Stale chat',  updated_at: iso(300 * 60_000) },
        { id: 'c2', title: 'Fresh chat',  updated_at: iso(2 * 60_000) },
      ],
    });
    useProjects.setState({
      list: [
        { id: 'p1', name: 'Dormant',  conversation_ids: ['c1'] },
        { id: 'p2', name: 'Active',   conversation_ids: ['c2'] },
        { id: 'p3', name: 'Untouched', conversation_ids: [] },
      ],
    });
    show();

    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.queryByText('Dormant')).toBeNull();
    // An empty project has no activity to report, so it is not "recent work".
    expect(screen.queryByText('Untouched')).toBeNull();
  });

  it('opens search narrowed to the project rather than guessing a chat', async () => {
    useConversations.setState({ list: [{ id: 'c1', title: 'A chat', updated_at: iso(60_000) }] });
    useProjects.setState({ list: [{ id: 'p1', name: 'Bloom', conversation_ids: ['c1'] }] });
    const user = userEvent.setup();
    show();

    await user.click(screen.getByText('Bloom'));

    expect(useUI.getState().searchOpen).toBe(true);
    expect(useUI.getState().searchScopeId).toBe('p1');
  });
});
