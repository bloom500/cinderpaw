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
    const tool = screen.getByText('Searched the web');
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

// His test, 4 Nov: a message typed mid-turn left the composer and showed nowhere
// for a minute, until the model's step ended.
describe('a message added while it works', () => {
  const message = (extra: object) =>
    ({ id: 'st', role: 'assistant', content: '', createdAt: 0, ...extra }) as unknown as ChatMessage;

  it('shows at once as their own bubble, faded while it waits', () => {
    render(<MemoryRouter><MessageItem message={message({ steerPending: ['make it shorter'] })} streaming /></MemoryRouter>);
    const bubble = screen.getByText('make it shorter').parentElement!;
    expect(bubble).toHaveClass('opacity-50');
    expect(bubble).toHaveAttribute('title', 'It reads this when its current step is done');
  });

  it('once read, it sits in the reply where the model read it, and the reply goes on under it', () => {
    const msg = message({ content: 'A long story.\n\nShort version.', steered: [{ text: 'make it shorter', at: 13, afterTools: 0 }] });
    // Done streaming: while it streams, the last text is drawn word by word.
    render(<MemoryRouter><MessageItem message={msg} /></MemoryRouter>);
    const before = screen.getByText('A long story.');
    const added = screen.getByText('make it shorter');
    const after = screen.getByText('Short version.');
    expect(added.parentElement).not.toHaveClass('opacity-50');
    expect(before.compareDocumentPosition(added) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(added.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a turn that never read it drops the waiting bubble', () => {
    render(<MemoryRouter><MessageItem message={message({ content: 'Stopped.', steerPending: ['too late'] })} /></MemoryRouter>);
    expect(screen.queryByText('too late')).toBeNull();
  });
});

describe('a reply the person stopped', () => {
  it('says so and offers to try again, even with no text yet', async () => {
    const onRetry = vi.fn();
    const message = { id: 's1', role: 'assistant', content: '', createdAt: 0, ended: { kind: 'stopped' } } as unknown as ChatMessage;
    render(<MemoryRouter><MessageItem message={message} onRetry={onRetry} /></MemoryRouter>);
    expect(screen.getByText('You stopped this reply.')).toBeTruthy();
    screen.getAllByRole('button', { name: 'Try again' }).at(-1)!.click();
    expect(onRetry).toHaveBeenCalled();
  });
});
