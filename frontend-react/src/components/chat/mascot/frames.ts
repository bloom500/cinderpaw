export type MascotState =
  | 'idle' | 'typing' | 'thinking' | 'calling' | 'done' | 'running'
  | 'wave' | 'sleep' | 'surprised' | 'curious' | 'celebrate'
  | 'reading' | 'searching' | 'building' | 'writing'
  | 'stretching' | 'gaming' | 'love' | 'cool' | 'error' | 'excited'
  | 'spawning';

export const FRAME_W = 16;
export const FRAME_H = 16;

// Terracotta-orange mid tone. The body used to be flat neon #F57A1F; it now
// reads as warm clay so the creature looks natural like the reference art.
const MASCOT_ORANGE = '#cf7740';
export const PALETTE: Record<string, string | null> = {
  '.': null,
  k: '#1c1c1e', o: MASCOT_ORANGE, w: '#ffffff', r: '#c0392b',
  y: '#f1c40f', g: '#27ae60', b: '#2980b9', p: '#8e44ad',
  c: '#16a085', s: '#7f8c8d', n: '#e67e22', m: '#e91e63',
};

// Body volume. The body char ('o') is the only large flat region; shading it by
// row fakes a top-lit, round body with a warm orange belly — so every one of
// the 127 frames gets dimension from one place instead of hand-painted shadows.
// ponytail: row ramp, not per-frame; the renderer swaps 'o' for BODY_SHADE[row].
export const BODY_CHAR = 'o';
function mix(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * Math.max(0, Math.min(1, t))));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}
export const BODY_SHADE: string[] = Array.from({ length: FRAME_H }, (_, row) => {
  const t = Math.max(0, Math.min(1, (row - 2) / 11)); // 0 = top .. 1 = feet line
  let col = mix(MASCOT_ORANGE, '#f4c285', Math.max(0, 0.30 - t * 0.34)); // upper highlight
  col = mix(col, '#7a3d1a', Math.max(0, t - 0.45) * 0.55);              // lower core shadow
  const belly = 1 - Math.abs(row - 8) / 5;                              // peak mid-body
  if (belly > 0) col = mix(col, '#ec8a33', belly * 0.30);              // warm orange belly
  return col;
});

export type Frame = string[];

const IDLE_BLINK: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const TYPING: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkoowkookwookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const THINK_L: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkowkoowkwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const THINK_R: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkookwoowwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CALL_OUT: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkoowkookwookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CALL_IN: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkookkowoowokk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const DONE: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkoorrrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const RUN_A: Frame = [
  '....o...........',
  '...oo...........',
  '..ookk..........',
  '.kkkkkk.........',
  '.kkooooooo......',
  '.kkoowooo.......',
  '.kkooooooo......',
  '.kkooowroo......',
  'kkooooooooo.....',
  'kkoooooooooo....',
  'kkoooooooooo....',
  'kkkooooookkkk...',
  '..kkkkkkkkk.....',
  '....kk.kk.......',
  '...kk...kk......',
  '..kk.....k......'
];

const RUN_B: Frame = [
  '....o...........',
  '...oo...........',
  '..ookk..........',
  '.kkkkkk.........',
  '.kkooooooo......',
  '.kkoowooo.......',
  '.kkooooooo......',
  '.kkooowroo......',
  'kkooooooooo.....',
  'kkoooooooooo....',
  'kkoooooooooo....',
  'kkkooooookkkk...',
  '..kkkkkkkkk.....',
  '....kk.kk.......',
  '...k....kk......',
  '...k.....kk.....'
];

const WAVE: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowwwwwookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const SLEEP: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooooooooookk.',
  '.kkooooooooookk.',
  '.kkooowwwwoookk.',
  'kkkooooooooookkk',
  'kkkk.ooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const SLEEP_B: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooooooooookk.',
  '.kkooooooooookk.',
  '.kkooowwwwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const SURPRISED: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkkwkwookk.',
  '.kkookkkwkkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CURIOUS: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkk..',
  '.kooooooooook.k.',
  '.koowkookwook.k.',
  '.kookkookkook.k.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CURIOUS_L: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CELEBRATE: Frame = [
  'o..o........o..o',
  'oo..oo..oo..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrroookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const IMA: Frame = [
  '...o.y......o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooooooooookk.',
  '.kkooooooooookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const IMB: Frame = [
  '...o.y......o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooo.rrr.ookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const IBA: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkoooooooogkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const IBB: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookgkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const IBC: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkoooooooogkkkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const IBRA: Frame = [
  '..go........o...',
  '..go..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const IBRB: Frame = [
  '..go........o...',
  '.ooo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const ISA: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const ISB: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const ICORA: Frame = [
  '...o.g......o...',
  '..oobgkkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const ICORB: Frame = [
  '...o.g......o...',
  '..oobgkkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const ISIT1: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk.kkk.....',
  '....kk..kk......'
];

const ISIT2: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk.kk......',
  '....kk..kkk.....'
];

const TPE: Frame = [
  '.y.o........o...',
  '.yoo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkoowkookwookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const TCA: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkoowkookwookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooobkkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const TCB: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkoowkookwookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkoooooobwkkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const TCC: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkoowkookwookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookssk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkks...',
  '....kk....kk....'
];

const TSA: Frame = [
  '...o.c......o...',
  '..oo.ccc....oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const TSB: Frame = [
  '...o.c......o...',
  '..oo..cc....oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const TRA: Frame = [
  '...o.c......o...',
  '..ooc..ckk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const TRB: Frame = [
  '...o.c......o...',
  '..oo.c...k..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const TMG: Frame = [
  '...o.w......o...',
  '..ooww..kk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const TQA: Frame = [
  '.y.o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const TQB: Frame = [
  '..yo........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const TDF: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkowooookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CFA: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkookkowoowokk.',
  '.kkooowrrwoookk.',
  'kkkooooooob..kkk',
  'kkkkkoooob...kkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CFB: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkookkowoowokk.',
  '.kkooowrrwoookk.',
  'kkkooooooobb.kkk',
  'kkkkkoooobb..kkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CDBA: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkookkowoowokk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookbskk',
  'kkkkooooooobskkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CDBB: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkookkowoowokk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooobs.kkk',
  'kkkkooooooobskkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CBRA: Frame = [
  '...o.b......o...',
  '..oobb..kk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkookkowoowokk.',
  '.kkooowrrwoookk.',
  'kkkooooooob..kkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CBRB: Frame = [
  '...o.b......o...',
  '..oobb..kk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkookkowoowokk.',
  '.kkooowrrwoookk.',
  'kkkooooooob..kkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CAPIa: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkookkowoowokk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkpwpoooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CAPIb: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkookkowoowokk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkpwpoooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CLOa: Frame = [
  '...oyk......o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkookkowoowokk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CLOb: Frame = [
  '...oky......o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkookkowoowokk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CHAa: Frame = [
  '...yyy......o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkookkowoowokk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CHAb: Frame = [
  '...oyyy.....o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkookkowoowokk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CCPA: Frame = [
  '....o...........',
  '...pp...........',
  '..oopp..........',
  '.kkkkkk.........',
  '.kkooooooo......',
  '.kkoowooo.......',
  '.kkooooooo......',
  '.kkooowroo......',
  'kkooooooooo.....',
  'kkoooooooooo....',
  'kkoooooooooo....',
  'kkkooooookkkk...',
  '..kkkkkkkkk.....',
  '....kk.kk.......',
  '....kk....kk....',
  '....kk.....kk...'
];

const CCPB: Frame = [
  '....o...........',
  '...opp..........',
  '..oopp..........',
  '.kkkkkk.........',
  '.kkooooooo......',
  '.kkoowooo.......',
  '.kkooooooo......',
  '.kkooowroo......',
  'kkooooooooo.....',
  'kkoooooooooo....',
  'kkoooooooooo....',
  'kkkooooookkkk...',
  '..kkkkkkkkk.....',
  '....kk.kk.......',
  '....kk....kk....',
  '....kk.....kk...'
];

const CBLKa: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkookkowoowokk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkbgboooookkkk',
  'kkkkbgboooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CBLKb: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkookkowoowokk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkbyboooookkkk',
  'kkkkbgboooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CTWA: Frame = [
  '....o...........',
  '...oo...........',
  '..ookk..........',
  '.kkkkkk.........',
  '.kkooooooo......',
  '.kkoowooo.......',
  '.kkooooooo......',
  '.kkooowroo......',
  'kkooooooooo.....',
  'kkoooooooooo....',
  'kkoooooooooo....',
  'kkkooooookkkk...',
  '..kkkkkkkkk.....',
  '....kk.kk.......',
  '...s......kk....',
  '...s.......kk...'
];

const CTWB: Frame = [
  '....o...........',
  '...oo...........',
  '..ookk..........',
  '.kkkkkk.........',
  '.kkooooooo......',
  '.kkoowooo.......',
  '.kkooooooo......',
  '.kkooowroo......',
  'kkooooooooo.....',
  'kkoooooooooo....',
  'kkoooooooooo....',
  'kkkooooookkkk...',
  '..kkkkkkkkk.....',
  '....kk.kk.......',
  '....s.....kk....',
  '....s......kk...'
];

const DCKa: Frame = [
  '...o.g......o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkoorrrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const DCKb: Frame = [
  '...o.g......o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkoorrrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const DCO: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkskkookkkskkk.',
  '.kkoorrrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const DSPa: Frame = [
  '.y.o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkoorrrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const DSPb: Frame = [
  '..yo........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkoorrrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const DCNa: Frame = [
  '...o.y......o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkoorrrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const DCNb: Frame = [
  '...oyy......o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkoorrrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const DGRa: Frame = [
  '.g.o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkoorrrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const DGRb: Frame = [
  '..go........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkoorrrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CFa: Frame = [
  'y.ry........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrroookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CFb: Frame = [
  'ry.y........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrroookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CCFa: Frame = [
  'y..o...p...o..y.',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrroookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CCFb: Frame = [
  'p..o...y...o..g.',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrroookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CSPa: Frame = [
  'o..o...y....o..o',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrroookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CSPb: Frame = [
  'o..o..y.....o..o',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrroookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CFWa: Frame = [
  'y..o...p...o..y.',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrroookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CFWb: Frame = [
  'p..o...y...o..p.',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrroookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const SXA: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkrrkwookk.',
  '.kkookkrrkkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const SAA: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkkwkwookk.',
  '.kkookkkwkkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const SAB: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkkwkwookk.',
  '.kkookkkwkkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const STA: Frame = [
  'r.o.......o.r...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkkwkwookk.',
  '.kkookkkwkkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const STB: Frame = [
  '.r..o.......o..r',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkkwkwookk.',
  '.kkookkkwkkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const WFA: Frame = [
  '..o.g.......b.o.',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowwwwwookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const WFB: Frame = [
  '..o.b.......g.o.',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowwwwwookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const WSA: Frame = [
  '...o.yy.....o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowwwwwookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const WSB: Frame = [
  '...o..yy....o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowwwwwookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const WBA: Frame = [
  '...om.......o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowwwwwookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const WBB: Frame = [
  '...om.......o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowwwwwookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const SZA: Frame = [
  '...os.......o...',
  '..ooss.kkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooooooooookk.',
  '.kkooooooooookk.',
  '.kkooowwwwoookk.',
  'kkkooooooooookkk',
  'kkkk.ooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const SZB: Frame = [
  '...o.s......o...',
  '..oo.ss.kk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooooooooookk.',
  '.kkooooooooookk.',
  '.kkooowwwwoookk.',
  'kkkooooooooookkk',
  'kkkk.ooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const SZC: Frame = [
  '...o..s.....o...',
  '..oo..ss.k..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooooooooookk.',
  '.kkooooooooookk.',
  '.kkooowwwwoookk.',
  'kkkooooooooookkk',
  'kkkk.ooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const SMO: Frame = [
  '...oy.......o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooooooooookk.',
  '.kkooooooooookk.',
  '.kkooowwwwoookk.',
  'kkkooooooooookkk',
  'kkkk.ooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CUA: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkoowkooooookk.',
  '.kkokkkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CUB: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkokwoooooookk.',
  '.kkokkkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CGA: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkoooooobgkkk',
  'kkkkooooooobgkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CGB: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooobg.kkk',
  'kkkkooooooobgkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const RCA: Frame = [
  '....o...........',
  '...p............',
  '..oop...........',
  '.kkkkkk.........',
  '.kkooooooo......',
  '.kkoowooo.......',
  '.kkooooooo......',
  '.kkooowroo......',
  'kkooooooooo.....',
  'kkoooooooooo....',
  'kkoooooooooo....',
  'kkkooooookkkk...',
  '..kkkkkkkkk.....',
  '....kk.kk.......',
  '....kk....kk....',
  '....kk.....kk...'
];

const RCB: Frame = [
  '....o...........',
  '...op...........',
  '..oop...........',
  '.kkkkkk.........',
  '.kkooooooo......',
  '.kkoowooo.......',
  '.kkooooooo......',
  '.kkooowroo......',
  'kkooooooooo.....',
  'kkoooooooooo....',
  'kkoooooooooo....',
  'kkkooooookkkk...',
  '..kkkkkkkkk.....',
  '....kk.kk.......',
  '....kk....kk....',
  '....kk.....kk...'
];

const RWA: Frame = [
  '....o...........',
  '...oo...........',
  '..ookk..........',
  '.kkkkkk.........',
  '.kkooooooo......',
  '.kkoowooo.......',
  '.kkooooooo......',
  '.kkooowroo......',
  'kkooooooooo.....',
  'kkoooooooooo....',
  'kkoooooooooo....',
  'kkkooooookkkk...',
  '..kkkkkkkkk.....',
  '....kk.kk.......',
  '...s......kk....',
  '...s.......kk...'
];

const RWB: Frame = [
  '....o...........',
  '...oo...........',
  '..ookk..........',
  '.kkkkkk.........',
  '.kkooooooo......',
  '.kkoowooo.......',
  '.kkooooooo......',
  '.kkooowroo......',
  'kkooooooooo.....',
  'kkoooooooooo....',
  'kkoooooooooo....',
  'kkkooooookkkk...',
  '..kkkkkkkkk.....',
  '....kk.kk.......',
  '....s.....kk....',
  '....s......kk...'
];

const RDA: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkowkoowkwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const RDB: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkowkoowkkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const RDC: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkookkowoowokk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const SRA: Frame = [
  '...o.w......o...',
  '..ooww..kk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const SRB: Frame = [
  '...o.......wo...',
  '..oo..kkww..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const BDA: Frame = [
  '...yyy......o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const BDB: Frame = [
  '...oyyy.....o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const WRA: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookk.k',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const WRB: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooook..k',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const STA1: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  '.kkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const STA2: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  '..kooooooooookkk',
  '..kkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const STA3: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  '...koooooooookkk',
  '....kooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const GMA: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkbbbbboookkkk',
  'kkkkbbbbboookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const GMB: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkbbbbboookkkk',
  'kkkkobbbb.ookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const GRA: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkbbbbboookkkk',
  'kkkkbbbbboookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk.kkk.....',
  '....kk..kk......'
];

const GRB: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkobbbb.ookkkk',
  'kkkkbbbbboookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk.kkk.....',
  '....kk..kk......'
];

const LOA: Frame = [
  '...o........o...',
  '..oom..kkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const LOB: Frame = [
  '...omm......o...',
  '..oommmkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const COA: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkskkookkkskkk.',
  '.kkoorrrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CGA2: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkskkookkkskkk.',
  '.kkoorrrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkoooooobgkkk',
  'kkkkooooooobgkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const EXA: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkrrkwookk.',
  '.kkookkrrkkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const EDA: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkooo.rrr.ookk.',
  'kkkooooooooookkk',
  'kkkk.ooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const ESA: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooooooooookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const EXC1: Frame = [
  '.y.o........o...',
  '.yyo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const EXC2: Frame = [
  '..y.........o...',
  '..yy..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const SPB: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkkk...',
  '....kk....kkk...'
];

const SPC: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkkk...',
  '....kk....kkk...'
];

const SPA: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowkookwookk.',
  '.kkookkookkookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

export const VARIANTS: Record<MascotState, Frame[][]> = {
  idle:      [[SPA,SPA,SPA,IDLE_BLINK],[IMA,IMB],[IBA,IBB,IBC],[IBRA,IBRB],[ISA,ISB],[ICORA,ICORB],[ISIT1,ISIT2]],
  typing:    [[TYPING],[TPE],[TCA,TCB],[TCC]],
  thinking:  [[THINK_L,THINK_R],[TSA,TSB],[TRA,TRB],[TMG],[TQA,TQB],[TDF]],
  calling:   [[CALL_OUT,CALL_IN],[CFA,CFB],[CDBA,CDBB],[CBRA,CBRB],[CAPIa,CAPIb],[CLOa,CLOb],[CHAa,CHAb],[CCPA,CCPB],[CBLKa,CBLKb],[CTWA,CTWB]],
  done:      [[DONE,DONE],[DCKa,DCKb],[DCO,DCO],[DSPa,DSPb],[DCNa,DCNb],[DGRa,DGRb]],
  running:   [[RUN_A,RUN_B],[RCA,RCB],[RWA,RWB]],
  wave:      [[WAVE,WAVE],[WFA,WFB],[WSA,WSB],[WBA,WBB]],
  sleep:     [[SLEEP,SLEEP,SLEEP,SLEEP_B,SLEEP_B,SLEEP],[SLEEP,SZA,SZB,SZC,SZB,SZA],[SMO,SMO,SMO,SLEEP_B,SLEEP_B,SMO]],
  surprised: [[SURPRISED,SURPRISED],[SXA,SXA],[SAA,SAB],[STA,STB]],
  curious:   [[SPA,CURIOUS,SPA,CURIOUS_L],[CUA,CUB],[CGA,CGB]],
  celebrate: [[CELEBRATE,CELEBRATE],[CFa,CFb],[CCFa,CCFb],[CSPa,CSPb],[CFWa,CFWb]],
  reading:   [[RDA,RDB,RDC]],
  searching: [[SRA,SRB]],
  building:  [[BDA,BDB]],
  writing:   [[WRA,WRB]],
  stretching:[[STA1,STA2,STA3]],
  gaming:    [[GMA,GMB],[GRA,GRB]],
  love:      [[LOA,LOB]],
  cool:      [[COA,COA],[CGA2,CGA2]],
  error:     [[EXA,EXA],[EDA,EDA],[ESA,ESA]],
  excited:   [[EXC1,EXC2]],
  spawning:  [[SPA,SPB,SPC]],
};

export const FRAMES: Record<MascotState, Frame[]> = {
  idle:VARIANTS.idle[0],typing:VARIANTS.typing[0],thinking:VARIANTS.thinking[0],
  calling:VARIANTS.calling[0],done:VARIANTS.done[0],running:VARIANTS.running[0],
  wave:VARIANTS.wave[0],sleep:VARIANTS.sleep[0],surprised:VARIANTS.surprised[0],
  curious:VARIANTS.curious[0],celebrate:VARIANTS.celebrate[0],
  reading:VARIANTS.reading[0],searching:VARIANTS.searching[0],building:VARIANTS.building[0],
  writing:VARIANTS.writing[0],stretching:VARIANTS.stretching[0],gaming:VARIANTS.gaming[0],
  love:VARIANTS.love[0],cool:VARIANTS.cool[0],error:VARIANTS.error[0],
  excited:VARIANTS.excited[0],spawning:VARIANTS.spawning[0],
};
