import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CinderpawMascot } from '../CinderpawMascot';
import { VARIANTS, type MascotState } from '../frames';
import { SCENES } from '../scenes';

const ALL_STATES = Object.keys(VARIANTS) as MascotState[];

describe('CinderpawMascot (SVG)', () => {
  it('draws every state the app can ask for', () => {
    for (const state of ALL_STATES) {
      const { container, unmount } = render(<CinderpawMascot state={state} />);
      const svg = container.querySelector('svg');
      expect(svg, state).not.toBeNull();
      expect(svg!.getAttribute('data-mascot-state')).toBe(state);
      // Something is actually drawn, not an empty frame.
      expect(svg!.querySelectorAll('path, ellipse').length, state).toBeGreaterThan(4);
      unmount();
    }
  });

  it('keeps the 128x132 footprint the perch places by, at any size', () => {
    const { container } = render(<CinderpawMascot state="idle" width={256} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 128 132');
    expect(svg.getAttribute('width')).toBe('256');
    expect(svg.getAttribute('height')).toBe('264');
  });

  it('is decoration to a screen reader', () => {
    const { container } = render(<CinderpawMascot state="wave" />);
    expect(container.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
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
