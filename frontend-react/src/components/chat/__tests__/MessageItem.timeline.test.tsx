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

describe('the artifacts a reply draws as cards', () => {
  // Ids from the clock collide inside one test millisecond; the live ones come from the call.
  let n = 0;
  const done = (tool: string, data: Record<string, unknown>) =>
    ({ ...finishActivity(startActivity(tool, { id: data.id }), { ok: true, content: '', data }), id: `call-${n++}` });

  it('only what it made, once per artifact: a read is a step, a create then an edit is one card', () => {
    const message = {
      id: 'a2', role: 'assistant', content: 'Done.', createdAt: 0,
      toolActivity: [
        done('artifact_read', { id: 'old', kind: 'markdown', title: 'An older document', version: 1 }),
        done('artifact_create', { id: 'b', kind: 'board', title: 'New York, 7 days', version: 1 }),
        done('artifact_edit', { id: 'b', kind: 'board', title: 'New York, 7 days', version: 2 }),
        done('artifact_create', { id: 'c', kind: 'markdown', title: 'New York, full details', version: 1 }),
      ],
    } as unknown as ChatMessage;
    render(<MemoryRouter><MessageItem message={message} /></MemoryRouter>);

    expect(screen.getAllByRole('button', { name: 'Open New York, 7 days' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Open New York, full details' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Open An older document' })).toBeNull();
  });
});
