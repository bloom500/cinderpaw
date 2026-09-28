import { describe, it, expect } from 'vitest';
import { parseWidget, widgetOf } from '../widgets';

describe('parseWidget', () => {
  it('keeps a widget that fits its kind', () => {
    expect(parseWidget({ kind: 'progress', done: 3, total: 6, label: 'Bookings' }))
      .toEqual({ kind: 'progress', title: undefined, done: 3, total: 6, label: 'Bookings' });
  });

  it('turns one that does not fit, or an unknown kind, into a plain list of the same words', () => {
    expect(parseWidget({ kind: 'table', title: 'Laptops', columns: [{ title: 'Air' }], rows: [{ label: 'RAM', cells: ['16 GB'] }] }))
      .toEqual({ kind: 'list', title: 'Laptops', lines: ['Air', 'RAM · 16 GB'] });
    expect(parseWidget({ kind: 'map', text: 'Lisbon' })).toEqual({ kind: 'list', title: undefined, lines: ['Lisbon'] });
  });

  it('shows nothing rather than a blank card when there is nothing to show', () => {
    expect(parseWidget(null)).toBeNull();
    expect(parseWidget({ kind: 'map' })).toBeNull();
  });

  it('drops an image that is not https, and keeps the card', () => {
    const w = parseWidget({ kind: 'cards', items: [{ title: 'A', image: 'http://x/a.png' }, { title: 'B' }] });
    expect(w?.kind).toBe('cards');
    expect(w && 'items' in w && (w.items[0] as { image?: string }).image).toBeUndefined();
  });
});

describe('widgetOf', () => {
  it("draws todo_write's whole list as a checklist, in the order it was written", () => {
    const data = { items: [
      { id: 'b', content: 'Book hotel', status: 'in_progress', createdAt: 2 },
      { id: 'a', content: 'Book flights', status: 'done', createdAt: 1 },
    ] };
    expect(widgetOf('todo_write', { ok: true, data })).toEqual({
      kind: 'checklist', title: 'Plan',
      items: [{ text: 'Book flights', done: true }, { text: 'Book hotel', done: false }],
    });
  });

  it('is null for any other tool', () => {
    expect(widgetOf('web_search', { ok: true, data: { kind: 'verdict', text: 'x' } })).toBeNull();
  });
});

describe('cached pictures', () => {
  const file = '/home/ana/.cinderpaw/cache/images/' + 'a'.repeat(40) + '.jpg';
  it("keeps a file from the profile's image cache, and no other path", () => {
    const w = parseWidget({ kind: 'cards', items: [
      { title: 'Kept', imageFile: file },
      { title: 'Elsewhere', imageFile: '/home/ana/.ssh/id_rsa' },
      { title: 'Windows', imageFile: 'C:\\Users\\ana\\.cinderpaw\\cache\\images\\' + 'b'.repeat(40) + '.png' },
    ] });
    const items = (w as { items: { imageFile?: string }[] }).items;
    expect(items.map((i) => i.imageFile)).toEqual([file, undefined, 'C:\\Users\\ana\\.cinderpaw\\cache\\images\\' + 'b'.repeat(40) + '.png']);
  });
});

