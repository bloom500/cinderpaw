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

  it('keeps up to four follow-ups, trimmed, and none is nothing', () => {
    expect(parseWidget({ kind: 'followups', next: [' Add charts ', 'a', 'b', 'c', 'd'] }))
      .toEqual({ kind: 'followups', next: ['Add charts', 'a', 'b', 'c'] });
    expect(parseWidget({ kind: 'followups', next: [] })).toBeNull();
    // With a question it is the next-step card: two answers at most.
    expect(parseWidget({ kind: 'followups', ask: 'Send it to Ana?', next: ['Yes', 'Not now', 'Later'] }))
      .toEqual({ kind: 'followups', ask: 'Send it to Ana?', next: ['Yes', 'Not now'] });
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

  it('draws the WhatsApp code only when connectors_manage started pairing', () => {
    expect(widgetOf('connectors_manage', { ok: true, data: { id: 'whatsapp', whatsappPairing: true } })).toEqual({ kind: 'whatsapp_pair' });
    expect(widgetOf('connectors_manage', { ok: true, data: { id: 'whatsapp', enabled: true } })).toBeNull();
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

  it('photos keep only pictures from the cache, and are nothing when none is left', () => {
    const w = parseWidget({ kind: 'photos', items: [{ imageFile: file, title: 'Sales' }, { imageFile: '/home/ana/.ssh/id_rsa' }] });
    expect(w).toEqual({ kind: 'photos', title: undefined, items: [{ imageFile: file, title: 'Sales' }] });
    // Nothing left to draw: the titles as a plain list, never a blank gallery.
    expect(parseWidget({ kind: 'photos', items: [{ imageFile: '/etc/passwd', title: 'x' }] })?.kind).toBe('list');
  });
});

