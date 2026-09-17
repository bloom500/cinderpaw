import { describe, expect, it } from 'vitest';
import { pointerToPage, toEdits, type Overlay } from '../pdfEdits';
import { inkBounds } from '@/components/artifacts/SignaturePad';

describe('toEdits', () => {
  it('turns placed text, a signature and a changed field into the list the sidecar applies', () => {
    const overlays: Overlay[] = [
      { id: 'a', page: 0, kind: 'text', x: 0.1, y: 0.2, size: 12, text: 'Ana Pop' },
      { id: 'b', page: 1, kind: 'image', x: 0.5, y: 0.8, width: 0.3, height: 0.1, png: 'data:image/png;base64,AAA' },
    ];
    expect(toEdits(overlays, { name: 'Ana', city: 'Cluj' }, { name: 'Ana', city: '' })).toEqual([
      { type: 'field', name: 'city', value: 'Cluj' },
      { type: 'text', page: 0, x: 0.1, y: 0.2, size: 12, text: 'Ana Pop' },
      { type: 'image', page: 1, x: 0.5, y: 0.8, width: 0.3, height: 0.1, png: 'data:image/png;base64,AAA' },
    ]);
  });

  it('drops a text box nobody typed in', () => {
    expect(toEdits([{ id: 'a', page: 0, kind: 'text', x: 0, y: 0, size: 12, text: '  ' }], {}, {})).toEqual([]);
  });

  it('keeps a signature dragged past the edge on the page, instead of sending a value the sidecar refuses', () => {
    const [e] = toEdits([{ id: 'a', page: 0, kind: 'image', x: 0.9, y: 0.95, width: 0.3, height: 0.1, png: 'x' }], {}, {});
    expect(e).toMatchObject({ x: 0.9, y: 0.95 });
    expect((e as { width: number }).width).toBeCloseTo(0.1);
    expect((e as { height: number }).height).toBeCloseTo(0.05);
  });
});

describe('pointerToPage', () => {
  it('is a fraction of the page from its top-left, clamped to the page', () => {
    const rect = { left: 100, top: 50, width: 400, height: 800 };
    expect(pointerToPage(300, 450, rect)).toEqual({ x: 0.5, y: 0.5 });
    expect(pointerToPage(0, 2000, rect)).toEqual({ x: 0, y: 1 });
  });
});

describe('inkBounds', () => {
  it('crops a drawn signature to its ink, so no blank margin lands on the page', () => {
    const width = 40;
    const height = 40;
    const data = new Uint8ClampedArray(width * height * 4);
    data[(12 * width + 10) * 4 + 3] = 255; // ink at (10, 12)
    data[(25 * width + 20) * 4 + 3] = 255; // and at (20, 25)
    // Six pixels of margin around the ink, so a stroke's edge is not shaved off.
    expect(inkBounds({ data, width, height })).toEqual({ x: 4, y: 6, w: 22, h: 25 });
    expect(inkBounds({ data: new Uint8ClampedArray(400), width: 10, height: 10 })).toBeNull();
  });
});
