import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { setUsageSharing, summary, state } = vi.hoisted(() => ({
  setUsageSharing: vi.fn().mockResolvedValue(undefined),
  summary: vi.fn().mockResolvedValue({ ok: true, preview: null, sent: [], groups: [], month: '2026-10', sharing: null }),
  state: {
    settings: { usage_sharing: null } as { usage_sharing: boolean | null } | null,
    fetchSettings: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('@/lib/tauri', () => ({ tauri: { system: { setUsageSharing }, usage: { summary } } }));
vi.mock('@/stores/settings', () => ({ useSettings: (sel: (s: typeof state) => unknown) => sel(state) }));

import { ShareUsageCard } from '../ShareUsageCard';
import { useConversations } from '@/stores/conversations';
import { useAttention } from '@/lib/attention';

describe('ShareUsageCard', () => {
  beforeEach(() => {
    setUsageSharing.mockClear();
    state.fetchSettings.mockClear();
    state.settings = { usage_sharing: null };
    useConversations.setState({ list: [{ id: 'c1' }] as never });
    useAttention.setState({ waiting: [], holder: null });
  });

  it('waits for a first conversation: no favour asked before the app did anything', async () => {
    useConversations.setState({ list: [] });
    const { container } = render(<ShareUsageCard />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it('shows only when never asked', () => {
    state.settings = { usage_sharing: false };
    const { container } = render(<ShareUsageCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it('loads settings when they are not there yet, and stays hidden meanwhile', () => {
    state.settings = null;
    const { container } = render(<ShareUsageCard />);
    expect(container).toBeEmptyDOMElement();
    expect(state.fetchSettings).toHaveBeenCalled();
  });

  it('No thanks records false and hides', async () => {
    const { container } = render(<ShareUsageCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'No thanks' }));
    expect(setUsageSharing).toHaveBeenCalledWith(false);
    expect(container).toBeEmptyDOMElement();
  });

  it('on a machine with no tasks yet, "what is sent" shows an example day, not an empty box', async () => {
    render(<ShareUsageCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show me what is sent' }));
    expect(await screen.findByText(/No tasks yet/)).toBeInTheDocument();
    expect(await screen.findByText(/"tasks_main"/)).toBeInTheDocument();
  });

  it('when the agent is not running yet, the example day is still shown', async () => {
    summary.mockRejectedValueOnce(new Error('not running'));
    render(<ShareUsageCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show me what is sent' }));
    expect(await screen.findByText(/could not read this computer's numbers/)).toBeInTheDocument();
    expect(await screen.findByText(/"tasks_main"/)).toBeInTheDocument();
  });
});
