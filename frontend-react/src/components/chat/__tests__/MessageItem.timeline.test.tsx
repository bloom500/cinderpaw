import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { MessageItem } from '../MessageItem';
import { finishActivity, startActivity } from '@/hooks/useLiveToolActivity';
import type { ChatMessage } from '@/stores/chat';

vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

afterEach(cleanup);

describe('an agent reply with tools', () => {
  it('reads in the order it happened: text, tool, text', () => {
    const said = 'Hai să verific ce e real.';
    const search = { ...finishActivity(startActivity('web_search', { query: 'x' }), { ok: true, content: '' }), at: said.length };
    const message = {
      id: 'a1', role: 'assistant', content: `${said}\n\nIată ce e real acum.`, createdAt: 0, toolActivity: [search],
    } as unknown as ChatMessage;
    render(<MemoryRouter><MessageItem message={message} /></MemoryRouter>);

    const first = screen.getByText(said);
    const tool = screen.getByText(/^Worked for/);
    const last = screen.getByText('Iată ce e real acum.');
    // DOCUMENT_POSITION_FOLLOWING: the second node comes after the first.
    expect(first.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tool.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
