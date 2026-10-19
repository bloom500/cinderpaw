import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CinderpawMascot } from '../CinderpawMascot';
import { VARIANTS, type MascotState } from '../frames';
import { SCENES } from '../scenes';

const ALL_STATES = Object.keys(VARIANTS) as MascotState[];

/** The drawing inside the mascot's image. */
function drawing(container: HTMLElement): SVGSVGElement {
  const src = container.querySelector('img')!.getAttribute('src')!;
  const markup = decodeURIComponent(src.slice('data:image/svg+xml,'.length));
  return new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement as unknown as SVGSVGElement;
}

describe('CinderpawMascot (SVG)', () => {
  it('draws every state the app can ask for', () => {
    for (const state of ALL_STATES) {
      const { container, unmount } = render(<CinderpawMascot state={state} />);
      expect(container.querySelector('img')!.getAttribute('data-mascot-state')).toBe(state);
      const svg = drawing(container);
      expect(svg.getAttribute('data-mascot-state')).toBe(state);
      // Something is actually drawn, not an empty frame.
      expect(svg.querySelectorAll('path, ellipse').length, state).toBeGreaterThan(4);
      unmount();
    }
  });

  it('keeps the 128x132 footprint the perch places by, at any size', () => {
    const { container } = render(<CinderpawMascot state="idle" width={256} />);
    const img = container.querySelector('img')!;
    // The image carries room around the drawing and hangs it outside the box
    // with a negative margin: laid out, it is still 256 by 264.
    const margin = -parseFloat(img.style.margin);
    expect(Number(img.getAttribute('width')) - 2 * margin).toBe(256);
    expect(Number(img.getAttribute('height')) - 2 * margin).toBe(264);
    // And the drawing keeps its 128x132 units inside that room.
    const [x, y, w, h] = drawing(container).getAttribute('viewBox')!.split(' ').map(Number);
    expect([x + margin / 2, y + margin / 2, w - margin, h - margin]).toEqual([0, 0, 128, 132]);
  });

  it('is decoration to a screen reader', () => {
    const { container } = render(<CinderpawMascot state="wave" />);
    expect(container.querySelector('img')!.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('img')!.getAttribute('alt')).toBe('');
  });

  // An inline <svg> whose parts move with CSS transforms made Chromium re-walk
  // the whole page every frame (PrePaint, CompositingInputs): typing and
  // scrolling slowed down as the chat grew. The drawing, and its motion, live
  // inside an image so the page never sees them.
  it('moves inside its own image, never as inline SVG in the page', () => {
    const { container } = render(<CinderpawMascot state="idle" />);
    expect(container.querySelector('svg')).toBeNull();
    const css = drawing(container).querySelector('style')!.textContent!;
    expect(css).toContain('@keyframes cpm-breathe');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('holds still inside the image when the person asked for less motion', () => {
    const mq = { matches: true, addEventListener: () => {}, removeEventListener: () => {} };
    const original = window.matchMedia;
    window.matchMedia = (() => mq) as unknown as typeof window.matchMedia;
    try {
      const { container } = render(<CinderpawMascot state="done" />);
      const css = drawing(container).querySelector('style')!.textContent!;
      expect(css).not.toContain('prefers-reduced-motion');
      expect(css).toContain('@media all');
    } finally {
      window.matchMedia = original;
    }
  });

  it('draws every traced pose whole: a body, a face window and two eyes, on the ground', () => {
    for (const [name, scene] of Object.entries(SCENES)) {
      expect(scene.base.sil.length, name).toBeGreaterThan(200);
      expect(scene.face.length, name).toBeGreaterThan(50);
      expect(scene.eyes, name).toHaveLength(2);
      // Soles on the perch line: nothing drawn much below y=111.
      const ys = [...scene.base.sil.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => Number(m[2]));
      expect(Math.max(...ys), name).toBeLessThan(112);
    }
  });
});
