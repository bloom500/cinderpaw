import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ZoomableImage } from '../ZoomableImage';

afterEach(cleanup);

// His ask, 30 Oct: it took four clicks to see a detail of a screenshot and get
// out, and a zoomed picture could not be moved around.
describe('the image viewer', () => {
  const openViewer = async () => {
    render(<ZoomableImage src="data:image/png;base64,QUJD" alt="a screenshot" />);
    fireEvent.click(screen.getByRole('button', { name: /full size/ }));
    await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });
    return screen.getByTestId('image-lens');
  };

  it('a click on the picture zooms in, a drag moves it, a click on the dark closes it at once', async () => {
    const lens = await openViewer();
    fireEvent.click(lens, { clientX: 100, clientY: 80 });
    expect(lens.style.transform).toContain('scale(2.5)');

    const before = lens.style.transform;
    fireEvent.pointerDown(lens, { clientX: 100, clientY: 80, pointerId: 1 });
    fireEvent.pointerMove(lens, { clientX: 160, clientY: 120, pointerId: 1 });
    fireEvent.pointerUp(lens, { pointerId: 1 });
    expect(lens.style.transform).not.toBe(before);
    expect(lens.style.transform).toContain('scale(2.5)');
    // The click that ends a drag does not zoom back out.
    fireEvent.click(lens, { clientX: 160, clientY: 120 });
    expect(lens.style.transform).toContain('scale(2.5)');

    // One click on the dark, still zoomed: the picture heads home, unzoomed.
    fireEvent.click(screen.getByRole('button', { name: 'Close image preview' }));
    expect(lens.style.transform).toContain('scale(1)');
    expect(screen.getByRole('button', { name: 'Close image preview' }).className).toContain('bg-black/0');
  });

  it('a second click on the picture zooms back out', async () => {
    const lens = await openViewer();
    fireEvent.click(lens, { clientX: 10, clientY: 10 });
    fireEvent.click(lens, { clientX: 10, clientY: 10 });
    expect(lens.style.transform).toContain('scale(1)');
  });
});
