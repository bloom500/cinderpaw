import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatWidget } from '../ChatWidget';
import { MessageItem } from '../MessageItem';
import type { ChatMessage } from '@/stores/chat';
import { finishActivity, startActivity } from '@/hooks/useLiveToolActivity';

vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null), convertFileSrc: (p: string) => `asset://localhost/${p}` }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

describe('ChatWidget', () => {
  it('draws each kind from its data', () => {
    const { rerender } = render(<ChatWidget w={{ kind: 'checklist', title: 'Bookings', items: [
      { text: 'Flights', done: true }, { text: 'Hotel', done: false },
    ] }} />);
    expect(screen.getByText('1 of 2 done')).toBeTruthy();

    rerender(<ChatWidget w={{ kind: 'table', columns: [{ title: 'Air' }, { title: 'Pro' }], rows: [{ label: 'RAM', cells: ['16 GB', '32 GB'] }] }} />);
    expect(screen.getByRole('columnheader', { name: 'Pro' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: '32 GB' })).toBeTruthy();

    rerender(<ChatWidget w={{ kind: 'verdict', text: 'Take the Air.' }} />);
    expect(screen.getByText('My take')).toBeTruthy();

    rerender(<ChatWidget w={{ kind: 'breakdown', total: 2000, items: [{ label: 'Flights', value: 900 }] }} />);
    // The widget prints the number in the machine's own locale, so the test
    // has to ask for it the same way. Hard-coding the English "2,000" made
    // this fail on every machine whose locale writes a dot instead
    // (`(2000).toLocaleString()` is "2.000" under ro-RO), which is why
    // verify.sh was red on this box while the widget itself was right.
    expect(screen.getByText(`Total ${(2000).toLocaleString()}`)).toBeTruthy();

    rerender(<ChatWidget w={{ kind: 'cards', items: [{ title: 'Aventon', imageFile: '/p/a.jpg' }, { title: 'Ride1Up' }] }} />);
    // The kept picture is shown from its file; the card without one has the placeholder, not a broken image.
    expect(document.querySelectorAll('img')).toHaveLength(1);
    expect(document.querySelector('img')?.getAttribute('src')).toBe('asset://localhost//p/a.jpg');

    rerender(<ChatWidget w={{ kind: 'list', title: 'Laptops', lines: ['RAM · 16 GB'] }} />);
    expect(screen.getByText('RAM · 16 GB')).toBeTruthy();
  });
});

describe('widgets in a reply', () => {
  const plan = (n: number, done: boolean) => ({
    ...finishActivity(startActivity('todo_write', { action: 'set' }), { ok: true, data: { items: [
      { id: 'a', content: `Step ${n}`, status: done ? 'done' : 'todo', createdAt: 1 },
    ] } }),
    id: `todo-${n}`,
  });

  it('draws only the last plan of the reply; earlier updates stay steps', () => {
    const shown = { ...finishActivity(startActivity('show_widget', {}), { ok: true, data: { kind: 'verdict', text: 'Go with B.' } }), id: 'w' };
    const message = {
      id: 'a1', role: 'assistant', content: 'Done.', createdAt: 0,
      toolActivity: [plan(1, false), shown, plan(2, true)],
    } as unknown as ChatMessage;
    render(<MemoryRouter><MessageItem message={message} /></MemoryRouter>);
    expect(screen.getByText('Go with B.')).toBeTruthy();
    expect(screen.getByText('Step 2')).toBeTruthy();
    expect(screen.queryByText('Step 1')).toBeNull();
    expect(screen.getAllByText('Plan')).toHaveLength(1);
  });
});

describe('follow-up chips', () => {
  const followUps = (next: string[]) => ({
    ...finishActivity(startActivity('show_widget', {}), { ok: true, data: { kind: 'followups', next } }), id: 'f',
  });
  const reply = (next: string[]) => ({
    id: 'a1', role: 'assistant', content: 'Here is the plan.', createdAt: 0, toolActivity: [followUps(next)],
  } as unknown as ChatMessage);

  it('close the latest reply, at most four, and a chip only fills the composer', async () => {
    const pick = vi.fn();
    render(<MemoryRouter><MessageItem message={reply(['Add more charts', 'Make it shorter'])} onFollowUp={pick} /></MemoryRouter>);
    const group = screen.getByRole('group', { name: 'Follow-ups' });
    expect(group.querySelectorAll('button')).toHaveLength(2);
    screen.getByRole('button', { name: 'Add more charts' }).click();
    expect(pick).toHaveBeenCalledWith('Add more charts');
  });

  it('are not a step, and not shown on an older reply or while it streams', () => {
    const { rerender } = render(<MemoryRouter><MessageItem message={reply(['Add more charts'])} /></MemoryRouter>);
    expect(screen.queryByText('Add more charts')).toBeNull();
    expect(screen.queryByText(/show_widget|Show widget/i)).toBeNull();
    rerender(<MemoryRouter><MessageItem message={reply(['Add more charts'])} streaming onFollowUp={() => {}} /></MemoryRouter>);
    expect(screen.queryByText('Add more charts')).toBeNull();
  });
});
