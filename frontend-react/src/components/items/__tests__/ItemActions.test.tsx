/**
 * Phase 4 S2 — the actions have to work wherever the item is rendered, not
 * only inside the sidebar. These render them standalone, which is exactly how
 * Search and Home will use them.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationActions, ProjectActions } from '../ItemActions';
import { useProjects } from '@/stores/projects';
import { useConversations } from '@/stores/conversations';
import { useNotifications } from '@/stores/notifications';

const saveProject   = vi.fn(async () => {});
const deleteProject = vi.fn(async () => {});
const deleteConv    = vi.fn(async () => {});

vi.mock('@/lib/tauri', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    tauri: {
      projects: {
        list:   vi.fn(async () => useProjects.getState().list),
        save:   (...args: unknown[]) => saveProject(...(args as [])),
        delete: (...args: unknown[]) => deleteProject(...(args as [])),
      },
      conversations: {
        list:   vi.fn(async () => []),
        delete: (...args: unknown[]) => deleteConv(...(args as [])),
      },
    },
  };
});

const CONV = { id: 'c1', title: 'Tax questions' };

beforeEach(() => {
  vi.clearAllMocks();
  useProjects.setState({ list: [] });
  useConversations.setState({ list: [], currentId: null, streamingIds: {} });
});

describe('ConversationActions', () => {
  it('offers the projects a chat can be moved into', async () => {
    useProjects.setState({ list: [{ id: 'p1', name: 'Bloom', conversation_ids: [] }] });
    const user = userEvent.setup();

    render(<ConversationActions conv={CONV} />);
    await user.click(screen.getByLabelText('Chat options'));

    expect(await screen.findByText('Add to project')).toBeTruthy();
  });

  it('offers removal when the chat already sits in a project, with no host telling it so', async () => {
    // Nothing is passed in about the project: the component looks it up, which
    // is what makes it usable from Search and Home where there is no tree.
    useProjects.setState({ list: [{ id: 'p1', name: 'Bloom', conversation_ids: ['c1'] }] });
    const user = userEvent.setup();

    render(<ConversationActions conv={CONV} />);
    await user.click(screen.getByLabelText('Chat options'));

    expect(await screen.findByText('Remove from project')).toBeTruthy();
    expect(screen.queryByText('Add to project')).toBeNull();
  });

  // Delete with Undo, not "Are you sure?": the chat leaves the list at once and
  // is deleted from disk only when the undo window closes.
  it('removes the chat at once and deletes it when the undo window ends', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useConversations.setState({ list: [CONV as never] });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ConversationActions conv={CONV} />);

    await user.click(screen.getByLabelText('Chat options'));
    await user.click(await screen.findByText('Delete chat'));

    expect(useConversations.getState().list).toHaveLength(0);
    expect(deleteConv).not.toHaveBeenCalled();
    expect(useNotifications.getState().toasts.at(-1)?.action?.label).toBe('Undo');

    await vi.advanceTimersByTimeAsync(5_000);
    await waitFor(() => expect(deleteConv).toHaveBeenCalledWith('c1'));
    vi.useRealTimers();
  });

  it('never deletes when Undo is pressed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ConversationActions conv={CONV} />);

    await user.click(screen.getByLabelText('Chat options'));
    await user.click(await screen.findByText('Delete chat'));
    useNotifications.getState().toasts.at(-1)!.action!.run();

    await vi.advanceTimersByTimeAsync(6_000);
    expect(deleteConv).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('keeps a failed rename on screen, with the typed name still in the box', async () => {
    // Rename used to close the dialog whatever happened, so the row snapped
    // back to the old title and the reason went nowhere at all.
    saveProject.mockRejectedValueOnce(new Error('disk is read-only'));
    useProjects.setState({ list: [{ id: 'p1', name: 'Bloom', conversation_ids: [] }] });
    const user = userEvent.setup();

    render(<ProjectActions project={{ id: 'p1', name: 'Bloom' }} />);
    await user.click(screen.getByLabelText('Project options'));
    await user.click(await screen.findByText(/Rename/));

    const box = await screen.findByDisplayValue('Bloom');
    await user.clear(box);
    await user.type(box, 'Bloom Media');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/disk is read-only/)).toBeTruthy();
    expect(screen.getByDisplayValue('Bloom Media')).toBeTruthy();
  });
});

describe('ProjectActions', () => {
  it('renames through its own dialog', async () => {
    useProjects.setState({ list: [{ id: 'p1', name: 'Bloom', conversation_ids: [] }] });
    const user = userEvent.setup();

    render(<ProjectActions project={{ id: 'p1', name: 'Bloom' }} />);
    await user.click(screen.getByLabelText('Project options'));
    await user.click(await screen.findByText('Rename'));

    const input = await screen.findByLabelText('Project name');
    await user.clear(input);
    await user.type(input, 'Bloom Media{Enter}');

    await waitFor(() => expect(saveProject).toHaveBeenCalledWith('p1', 'Bloom Media', []));
  });

  it('warns that deleting a project takes its conversations with it', async () => {
    const user = userEvent.setup();
    render(<ProjectActions project={{ id: 'p1', name: 'Bloom' }} />);

    await user.click(screen.getByLabelText('Project options'));
    await user.click(await screen.findByText('Delete project'));

    expect(await screen.findByText(/every conversation inside it/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteProject).toHaveBeenCalledWith('p1'));
  });
});
