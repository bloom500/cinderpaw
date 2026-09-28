/**
 * ChatHeader — the open chat's name, its project, and its menu; nothing on
 * Home, where there is no chat to name.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatHeader } from '../ChatHeader';
import { useConversations } from '@/stores/conversations';
import { useProjects } from '@/stores/projects';
import { useArtifacts } from '@/stores/artifacts';

// The download store subscribes to host events when it is imported; there is no host here.
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

const CHAT = { id: 'c1', title: 'Plan the launch week' };

beforeEach(() => {
  useConversations.setState({ currentId: null, list: [CHAT] as never });
  useProjects.setState({ list: [] });
});

describe('ChatHeader', () => {
  it('shows no title and no menu on Home', () => {
    render(<ChatHeader />);
    expect(screen.queryByText(CHAT.title)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Chat options' })).toBeNull();
  });

  it("shows the chat's title and its menu", () => {
    useConversations.setState({ currentId: 'c1' });
    render(<ChatHeader />);
    expect(screen.getByText(CHAT.title)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Chat options' })).toBeTruthy();
    expect(screen.queryByText(/^in /)).toBeNull();
  });

  it('opens the Context tab, and closes it again', async () => {
    useConversations.setState({ currentId: 'c1' });
    useArtifacts.setState({ panelOpen: false, panelTab: 'artifacts' });
    render(<ChatHeader />);
    await userEvent.click(screen.getByRole('button', { name: 'Chat context' }));
    expect(useArtifacts.getState()).toMatchObject({ panelOpen: true, panelTab: 'context' });
    await userEvent.click(screen.getByRole('button', { name: 'Chat context' }));
    expect(useArtifacts.getState().panelOpen).toBe(false);
  });

  it('names the project the chat is in', () => {
    useConversations.setState({ currentId: 'c1' });
    useProjects.setState({ list: [{ id: 'p1', name: 'Cinderpaw launch', conversation_ids: ['c1'] }] as never });
    render(<ChatHeader />);
    expect(screen.getByText('in Cinderpaw launch')).toBeTruthy();
  });

  it('the chevron renames the chat', async () => {
    const rename = vi.fn(async () => {});
    useConversations.setState({ currentId: 'c1', rename } as never);
    render(<ChatHeader />);

    await userEvent.click(screen.getByRole('button', { name: 'Rename chat' }));
    const field = screen.getByLabelText('Chat name');
    await userEvent.clear(field);
    await userEvent.type(field, 'Launch week{Enter}');

    expect(rename).toHaveBeenCalledWith('c1', 'Launch week');
  });
});
