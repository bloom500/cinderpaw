import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MessageItem } from '../MessageItem';
import type { ChatMessage } from '@/stores/chat';
import { finishActivity, startActivity } from '@/hooks/useLiveToolActivity';

vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

describe('source chips in a reply', () => {
  it('a link to a page the search found is a chip and closes the answer as a source; other links stay links', () => {
    const search = {
      ...finishActivity(startActivity('web_search', { query: 'e-bikes' }), { ok: true }),
      hits: [{ title: 'Best commuter e-bikes', url: 'https://electrek.co/best', host: 'electrek.co', snippet: '', crumbs: '' }],
    };
    const message = {
      id: 'a1', role: 'assistant', createdAt: 0, toolActivity: [search],
      content: 'The [Electrek roundup](https://electrek.co/best) agrees; my notes are [here](https://example.org).',
    } as unknown as ChatMessage;
    render(<MemoryRouter><MessageItem message={message} /></MemoryRouter>);

    expect(screen.getByRole('link', { name: 'electrek.co' })).toBeTruthy();
    expect(screen.getByText(/Electrek roundup/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'here' }).getAttribute('href')).toBe('https://example.org');
    const list = screen.getByRole('region', { name: 'Sources' });
    expect(list.textContent).toContain('Best commuter e-bikes');
  });
});
