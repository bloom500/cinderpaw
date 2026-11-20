import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
const { ui } = vi.hoisted(() => ({ ui: vi.fn(async (_op: string) => ({ tabs: [{ id: 1 }] }) as unknown) }));
vi.mock('@/lib/tauri', async (orig) => {
  const actual = await orig<typeof import('@/lib/tauri')>();
  return { ...actual, tauri: { ...actual.tauri, browser: { ...actual.tauri.browser, ui } } };
});

import { useTidyAgentTabs } from '../useTidyAgentTabs';
import { useChat } from '@/stores/chat';
import { useBrowser } from '@/stores/browser';
import { useNotifications } from '@/stores/notifications';

// 1 Nov: ten job links left ten tabs open after the task; closing them silently
// would leave the person wondering where they went.
describe('useTidyAgentTabs', () => {
  it('closes finished agent tabs when a reply ends and says so, with Reopen', async () => {
    const push = vi.spyOn(useNotifications.getState(), 'push');
    useBrowser.setState({
      closed: [],
      tabs: [
        { id: 1, title: 'Job 1', url: 'https://jobs.example/1', loading: false, agent: true },
        { id: 2, title: 'Job 2', url: 'https://jobs.example/2', loading: false, agent: true },
      ] as never,
    });
    useChat.setState({ streamStatus: 'idle' });
    renderHook(() => useTidyAgentTabs());
    useChat.setState({ streamStatus: 'streaming' });
    expect(ui).not.toHaveBeenCalled();
    useChat.setState({ streamStatus: 'done' });
    expect(ui).toHaveBeenCalledWith('close_agent_tabs');
    await vi.waitFor(() => expect(push).toHaveBeenCalled());
    const [, title, , action] = push.mock.calls.at(-1)!;
    expect(title).toBe('Cinderpaw closed a tab it was done with');
    expect(action?.label).toBe('Reopen');
    expect(useBrowser.getState().closed).toEqual(['https://jobs.example/2']);
  });

  it('does nothing when the agent has no tabs', () => {
    ui.mockClear();
    useBrowser.setState({ tabs: [] });
    useChat.setState({ streamStatus: 'streaming' });
    useChat.setState({ streamStatus: 'done' });
    expect(ui).not.toHaveBeenCalled();
  });
});
