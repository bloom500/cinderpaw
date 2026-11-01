import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
const { ui } = vi.hoisted(() => ({ ui: vi.fn(async () => ({})) }));
vi.mock('@/lib/tauri', async (orig) => {
  const actual = await orig<typeof import('@/lib/tauri')>();
  return { ...actual, tauri: { ...actual.tauri, browser: { ...actual.tauri.browser, ui } } };
});

import { useTidyAgentTabs } from '../useTidyAgentTabs';
import { useChat } from '@/stores/chat';
import { useBrowser } from '@/stores/browser';

// 1 Nov: ten job links left ten tabs open after the task.
describe('useTidyAgentTabs', () => {
  it('asks the browser to close finished agent tabs when a reply ends, and only then', () => {
    useBrowser.setState({ tabs: [{ id: 1, title: 'Job', url: 'https://jobs.example', loading: false, agent: true }] as never });
    useChat.setState({ streamStatus: 'idle' });
    renderHook(() => useTidyAgentTabs());
    useChat.setState({ streamStatus: 'streaming' });
    expect(ui).not.toHaveBeenCalled();
    useChat.setState({ streamStatus: 'done' });
    expect(ui).toHaveBeenCalledWith('close_agent_tabs');
    ui.mockClear();
    useBrowser.setState({ tabs: [] });
    useChat.setState({ streamStatus: 'streaming' });
    useChat.setState({ streamStatus: 'done' });
    expect(ui).not.toHaveBeenCalled();
  });
});
