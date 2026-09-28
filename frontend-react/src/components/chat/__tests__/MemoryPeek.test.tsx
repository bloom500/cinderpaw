import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { MemoryPeek } from '../MemoryPeek';
import { MessageItem } from '../MessageItem';
import type { ChatMessage } from '@/stores/chat';
import { tauri } from '@/lib/tauri';
import { finishActivity, startActivity } from '@/hooks/useLiveToolActivity';

vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

describe('MemoryPeek', () => {
  it('draws nothing when no memory was used', () => {
    const { container } = render(<MemoryPeek items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('counts the memories, and a fact can be forgotten from here; a past chat cannot', async () => {
    const forget = vi.spyOn(tauri.raw, 'memoryForget').mockResolvedValue(undefined);
    render(<MemoryPeek items={[
      { kind: 'fact', text: 'city: Cluj', forget: { from: 'k', to: 'v', relation: 'has' } },
      { kind: 'past', text: 'we planned the launch week', ts: Date.UTC(2026, 8, 20) },
    ]} />);
    await userEvent.click(screen.getByRole('button', { name: /2 memories used/ }));
    expect(screen.getAllByRole('button', { name: 'Forget' })).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Forget' }));
    expect(forget).toHaveBeenCalledWith('k', 'v', 'has');
    expect(screen.getByRole('button', { name: 'Forgotten' })).toBeTruthy();
  });
});

describe('under a reply', () => {
  it('lists the injected memories and what a recall lookup found', async () => {
    const lookup = finishActivity(startActivity('recall', { query: 'pet' }), { ok: true });
    const message = {
      id: 'a1', role: 'assistant', content: 'Miso is doing well, I hope.', createdAt: 0,
      memoryUsed: [{ kind: 'fact', text: 'city: Cluj' }],
      toolActivity: [{ ...lookup, facts: ['pet: a cat named Miso'] }],
    } as unknown as ChatMessage;
    render(<MemoryRouter><MessageItem message={message} /></MemoryRouter>);
    await userEvent.click(screen.getByRole('button', { name: /2 memories used/ }));
    expect(screen.getByText('pet: a cat named Miso')).toBeTruthy();
  });
});
