/**
 * The motion contract (lib/motion.ts).
 *
 * Nothing moved wrong on its own. What read as "Lego" (Darius, 29 Oct) was
 * measured: 32 durations and 14 curves, springs that swung 16-30% past their
 * mark, each picked where it was needed and never compared with its
 * neighbours. Now everything that answers the person moves on Apple's
 * bounce-0 spring at one of three paces; a new one-off fails here, not on
 * somebody's screen.
 *
 * Out of scope on purpose: the vendored Sileo toasts (his gooey), the mascot
 * (character acting), Cubby's cursor magnet (it follows a hand, not a clock),
 * and loops that only show life (shimmer, breathing, spinners).
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CSS_TIME, MOTION, SPRING_CSS, cssMs, spring } from '@/lib/motion';

const RAW = import.meta.glob(['/src/**/*.{ts,tsx}', '!/src/**/__tests__/**', '!/src/test/**'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const EXEMPT = /\/sileo\/|\/mascot\/|useMagnetic|GooeyCard|lib\/motion\.ts/;
const FILES = Object.entries(RAW).filter(([p]) => !EXEMPT.test(p)).map(([p, text]) => ({ p, text }));
const CSS = readFileSync('src/styles/globals.css', 'utf8');

function hits(re: RegExp): string[] {
  return FILES.flatMap(({ p, text }) => [...text.matchAll(re)].map((m) => `${p}: ${m[0]}`));
}

describe('motion', () => {
  test("springs follow Apple's conversion: Spring(duration: 0.5, bounce: 0.3) is 157.9 / 17.6", () => {
    const s = spring(0.5, 0.3);
    expect(s.stiffness).toBeCloseTo(157.9, 1);
    expect(s.damping).toBeCloseTo(17.6, 1);
    // bounce 0 is critical damping: no overshoot, the "solid" in his ask.
    const b = spring(MOTION.base);
    expect(b.damping / (2 * Math.sqrt(b.stiffness * b.mass))).toBeCloseTo(1, 5);
  });

  test('the CSS curve is that spring, and it never passes the mark', () => {
    const ys = SPRING_CSS.slice('linear('.length, -1).split(',').map(Number);
    ys.forEach((y, i) => {
      const u = (i / (ys.length - 1)) * CSS_TIME * 2 * Math.PI;
      expect(y).toBeCloseTo(i === ys.length - 1 ? 1 : 1 - (1 + u) * Math.exp(-u), 3);
    });
    expect(Math.max(...ys)).toBe(1);
    expect(CSS).toContain(`--motion-ease: ${SPRING_CSS};`);
    expect(CSS).toContain(`--ease-out: ${SPRING_CSS};`);
    expect(CSS).toContain(`--default-transition-timing-function: ${SPRING_CSS};`);
  });

  test('three paces, the same in CSS and in code', () => {
    expect(CSS).toContain(`--motion-fast: ${cssMs(MOTION.fast)}ms;`);
    expect(CSS).toContain(`--motion-base: ${cssMs(MOTION.base)}ms;`);
    expect(CSS).toContain(`--motion-slow: ${cssMs(MOTION.slow)}ms;`);
    expect(CSS).toContain(`--default-transition-duration: ${cssMs(MOTION.fast)}ms;`);
  });

  test('no component picks its own curve or spring', () => {
    expect(hits(/cubic-bezier\(/g)).toEqual([]);
    expect(hits(/ease: ?(\[|')/g)).toEqual([]);
    expect(hits(/type: ?'spring'|stiffness:/g)).toEqual([]);
  });

  test('no component picks its own duration', () => {
    // 0 is "no motion", which reduced motion and drags need. The one exception:
    // live call captions land within a frame (20 ms), they must keep pace with
    // speech, not with the UI (CallOverlay.test pins it).
    expect(hits(/duration: ?(?!0\b)[0-9.]+/g)).toEqual([]);
    expect(hits(/\bduration-(?!0\b)\d+\b/g).filter((h) => h !== '/src/components/chat/CallOverlay.tsx: duration-20')).toEqual([]);
  });

  test('nothing in the stylesheet bounces past its size', () => {
    // A bezier with a y above 1 overshoots. Sileo's own CSS is not in this file.
    const ys = [...CSS.matchAll(/cubic-bezier\(([^)]*)\)/g)].map((m) => m[1].split(',').map(Number));
    expect(ys.filter(([, y1, , y2]) => y1 > 1 || y2 > 1)).toEqual([]);
  });
});
