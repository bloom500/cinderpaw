/**
 * Procedural pixel effects rendered AROUND the mascot sprite.
 *
 * The 16-bit reference set (getillustrations-style) shows the same body in
 * every pose, surrounded by bright accent props: confetti bursts, sparkles,
 * drifting Z's, rising hearts, thought dots, orbiting search pixels. The
 * mascot frames stay untouched — these effects are drawn each tick in the
 * margin area of the enlarged canvas, so the character itself never changes.
 *
 * All animation is a pure function of `tick` (deterministic, loops cleanly,
 * no per-frame allocation churn worth worrying about at 16×26 px).
 */

import type { MascotState } from './frames';

export interface EffectPixel {
  x: number;
  y: number;
  color: string;
}

/** Margin around the 16×18 sprite area inside the effects canvas. */
export const FX_MARGIN_X = 10;
export const FX_MARGIN_TOP = 8;

// Bright accent palette pulled from the reference sheets.
const LIME = '#4ade80';
const GOLD = '#fbbf24';
const PINK = '#f472b6';
const CYAN = '#22d3ee';
const LAVENDER = '#a78bfa';
const RED = '#ef4444';
const SLATE = '#94a3b8';
const WHITE = '#ffffff';

const CONFETTI_COLORS = [LIME, GOLD, PINK, CYAN, LAVENDER];

/** Cheap deterministic hash → [0, 1). Stable per (seed, i). */
function rand(seed: number, i: number): number {
  let h = (seed * 374761393 + i * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

/** 4-pixel diamond sparkle centred on (cx, cy); phase 0 = dot, 1 = star. */
function sparkle(cx: number, cy: number, color: string, phase: number): EffectPixel[] {
  if (phase === 0) return [{ x: cx, y: cy, color }];
  return [
    { x: cx, y: cy - 1, color },
    { x: cx - 1, y: cy, color },
    { x: cx + 1, y: cy, color },
    { x: cx, y: cy + 1, color },
  ];
}

/** Confetti burst: pixels arc up and out from the body, looping. */
function confetti(tick: number): EffectPixel[] {
  const out: EffectPixel[] = [];
  const PERIOD = 10;
  for (let i = 0; i < 10; i++) {
    const t = (tick + Math.floor(rand(7, i) * PERIOD)) % PERIOD;
    const left = i % 2 === 0;
    const baseX = left ? 6 : 29;
    const dir = left ? -1 : 1;
    const x = baseX + dir * Math.floor(t * (0.6 + rand(11, i)));
    const y = 14 - t + Math.floor(rand(13, i) * 6) - 3 + Math.floor(t * t * 0.12);
    if (x < 0 || x > 35 || y < 0 || y > 24) continue;
    out.push({ x, y, color: CONFETTI_COLORS[i % CONFETTI_COLORS.length] });
  }
  return out;
}

/** Gentle sparkles twinkling above the shoulders. */
function sparkles(tick: number, colors: string[]): EffectPixel[] {
  const spots: Array<[number, number]> = [
    [4, 6], [31, 8], [7, 14], [29, 16], [17, 2],
  ];
  const out: EffectPixel[] = [];
  spots.forEach(([x, y], i) => {
    const phase = Math.floor(tick / 2 + i) % 3;
    if (phase === 2) return; // off beat — twinkle
    out.push(...sparkle(x, y, colors[i % colors.length], phase));
  });
  return out;
}

/** Pixel hearts rising beside the head (love). */
function hearts(tick: number): EffectPixel[] {
  const out: EffectPixel[] = [];
  const PERIOD = 8;
  for (let i = 0; i < 3; i++) {
    const t = (tick + i * 3) % PERIOD;
    const x = (i % 2 === 0 ? 6 : 28) + (i === 2 ? 2 : 0);
    const y = 14 - t;
    if (y < 1) continue;
    // 3×2 pixel heart
    out.push(
      { x, y, color: PINK },
      { x: x + 2, y, color: PINK },
      { x, y: y + 1, color: PINK },
      { x: x + 1, y: y + 1, color: PINK },
      { x: x + 2, y: y + 1, color: PINK },
      { x: x + 1, y: y + 2, color: PINK },
    );
  }
  return out;
}

/** Z z z drifting up-right while sleeping. */
function zs(tick: number): EffectPixel[] {
  const out: EffectPixel[] = [];
  const PERIOD = 12;
  for (let i = 0; i < 3; i++) {
    const t = (tick + i * 4) % PERIOD;
    const x = 27 + Math.floor(t / 3);
    const y = 10 - t;
    if (y < 0 || x > 33) continue;
    // 3×3 pixel Z
    out.push(
      { x, y, color: SLATE }, { x: x + 1, y, color: SLATE }, { x: x + 2, y, color: SLATE },
      { x: x + 1, y: y + 1, color: SLATE },
      { x, y: y + 2, color: SLATE }, { x: x + 1, y: y + 2, color: SLATE }, { x: x + 2, y: y + 2, color: SLATE },
    );
  }
  return out;
}

/** Thought dots cycling above the head (thinking). */
function thoughtDots(tick: number): EffectPixel[] {
  const lit = tick % 4;
  const out: EffectPixel[] = [];
  for (let i = 0; i < 3; i++) {
    if (i > lit) break;
    out.push({ x: 22 + i * 3, y: 4 - i, color: i === 2 ? LIME : SLATE });
  }
  return out;
}

/** Cyan pixels orbiting the body (searching). */
function orbit(tick: number): EffectPixel[] {
  const out: EffectPixel[] = [];
  const cx = 18;
  const cy = 14;
  for (let i = 0; i < 3; i++) {
    const a = ((tick * 0.8 + i * 2.1) % 6.283);
    const x = Math.round(cx + Math.cos(a) * 13);
    const y = Math.round(cy + Math.sin(a) * 7);
    if (x < 0 || x > 35 || y < 0 || y > 25) continue;
    out.push({ x, y, color: CYAN });
  }
  return out;
}

/** Red cross flashing beside the head (error). */
function errorCross(tick: number): EffectPixel[] {
  if (tick % 4 >= 3) return []; // blink off
  const x = 29;
  const y = 3;
  return [
    { x, y, color: RED }, { x: x + 2, y, color: RED },
    { x: x + 1, y: y + 1, color: RED },
    { x, y: y + 2, color: RED }, { x: x + 2, y: y + 2, color: RED },
  ];
}

/** Work sparks alternating sides (calling / building / writing). */
function workSparks(tick: number, color: string): EffectPixel[] {
  const left = tick % 2 === 0;
  const x = left ? 6 : 29;
  const y = 8 + (tick % 3);
  return sparkle(x, y, color, tick % 2);
}

/** Green check drawn pixel by pixel, then sparkle (done). */
function doneCheck(tick: number): EffectPixel[] {
  const CHECK: Array<[number, number]> = [
    [27, 7], [28, 8], [29, 7], [30, 6], [31, 5], [32, 4],
  ];
  const t = tick % 10;
  const visible = Math.min(CHECK.length, t + 2);
  const out: EffectPixel[] = CHECK.slice(0, visible).map(([x, y]) => ({ x, y, color: LIME }));
  if (t > 6) out.push(...sparkle(4, 6, GOLD, t % 2));
  return out;
}

export const EFFECTS: Partial<Record<MascotState, (tick: number) => EffectPixel[]>> = {
  celebrate: confetti,
  excited: confetti,
  done: doneCheck,
  cool: (t) => sparkles(t, [GOLD, CYAN, LAVENDER, GOLD, CYAN]),
  love: hearts,
  sleep: zs,
  thinking: thoughtDots,
  searching: orbit,
  reading: (t) => sparkles(t, [LAVENDER, SLATE, LAVENDER, SLATE, LAVENDER]),
  error: errorCross,
  calling: (t) => workSparks(t, GOLD),
  building: (t) => workSparks(t, GOLD),
  writing: (t) => workSparks(t, WHITE),
  spawning: (t) => sparkles(t, [LIME, CYAN, LIME, CYAN, LIME]),
  surprised: (t) => (t % 3 === 0 ? sparkle(28, 3, GOLD, 1) : []),
};
