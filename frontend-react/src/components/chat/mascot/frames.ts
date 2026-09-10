export type MascotState =
  | 'idle' | 'typing' | 'thinking' | 'calling' | 'done' | 'running'
  | 'wave' | 'sleep' | 'surprised' | 'curious' | 'celebrate'
  | 'reading' | 'searching' | 'building' | 'writing'
  | 'stretching' | 'gaming' | 'love' | 'cool' | 'error' | 'excited'
  | 'spawning' | 'meditating';

export const FRAME_W = 16;
export const FRAME_H = 16;

// Terracotta-orange mid tone. The body used to be flat neon #F57A1F; it now
// reads as warm clay so the creature looks natural like the reference art.
const MASCOT_ORANGE = '#cf7740';
export const PALETTE: Record<string, string | null> = {
  '.': null,
  // `k` is FUR and `e` is the INK of a face feature. They used to be one colour,
  // and that was the reason the creature could not be animated: at #1c1c1e the
  // fur measured 1.03:1 against the app's own dark surface, so the whole body
  // was invisible and only the orange face floated there. Every attempt at a
  // limb read as a dot in mid-air because the silhouette it should hang off did
  // not exist on screen.
  //
  // Lifting one shared colour would have taken the eyes with it -- they sit on
  // the orange patch and would have dropped from 5.7:1 to 2.8:1, undoing the
  // per-state faces. So the two roles are separate now: the fur is warm and
  // visible, the ink stays as black as it ever was.
  k: '#584c42', e: '#1c1c1e', o: MASCOT_ORANGE, w: '#ffffff', r: '#c0392b',
  y: '#f1c40f', g: '#27ae60', b: '#2980b9', p: '#8e44ad',
  c: '#16a085', s: '#7f8c8d', n: '#e67e22', m: '#e91e63',
};

// Body volume. The body char ('o') is the only large flat region; shading it by
// row fakes a top-lit, round body with a warm orange belly — so every one of
// the 127 frames gets dimension from one place instead of hand-painted shadows.
// ponytail: row ramp, not per-frame; the renderer swaps 'o' for BODY_SHADE[row].
// The two orange tufts on row 0-1 are deliberately ambiguous: they read as ears
// or as small horns depending on who is looking. That is the intent — the
// creature is a little beast, not a particular animal — so please do not "fix"
// them into one or the other on the assumption that the ambiguity is a bug.
//
// They are drawn with the body char, so the row-shading ramp below lights them
// from above like the rest of the body; a hardcoded orange there would make
// them the one flat part of the sprite.
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
  '.kkooeeooeeookk.',
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
  '.kkooeeooeeookk.',
  '.kkooweooewookk.',
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
  '.kkoweoowewookk.',
  '.kkooeeooeeookk.',
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
  '.kkooewoowwookk.',
  '.kkooeeooeeookk.',
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
  '.kkooeeooeeookk.',
  '.kkooweooewookk.',
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
  '.kkooeeooeeookk.',
  '.kkooeeowoowokk.',
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
  '.kkooeeooeeookk.',
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
  '.kkooooooooooeoo',
  '.kkooweooewooeoo',
  '.kkooeeooeeooee.',
  '.kkooowwwwwooee.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kookooooooookkkk',
  'kookooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const WAVE_B: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooweooewookk.',
  '.kkooeeooeeookoo',
  '.kkooowwwwwookoo',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kookooooooookkkk',
  'kookooooooookkkk',
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

// Wide round eyes and a small open mouth. The previous frame differed from
// THINK_L by two pixels — both were "slightly asymmetric small eyes" — so the
// mascot looked identical whether it was thinking or startled, and two states
// that mean different things told the user the same thing.
const SURPRISED: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowwoowwookk.',
  '.kkoowwoowwookk.',
  '.kkoooorrooookk.',
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
  '.kooweooewook.k.',
  '.kooeeooeeook.k.',
  '.keooowrrwoookk.',
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
  '.kkooweooewookk.',
  '.kkooeeooeeookk.',
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
  'ooeooooooooooeoo',
  'ooeooweooewooeoo',
  '.eeooeeooeeooee.',
  '.eeooowrrroooee.',
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
  '...o........o...',
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
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooweooewookk.',
  '.kkooeeooeeookk.',
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
  '.kkooweooewookk.',
  '.kkooeeooeeookk.',
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

const IBB: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooweooewookk.',
  '.kkooeeooeeookk.',
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

const IBC: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooweooewookk.',
  '.kkooeeooeeookk.',
  '.kkooowrrwoookk.',
  'kkkoooooooookkkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const IBRA: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooweooewookk.',
  '.kkooeeooeeookk.',
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
  '...o........o...',
  '.ooo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooweooewookk.',
  '.kkooeeooeeookk.',
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
  '.kkooweooewookk.',
  '.kkooeeooeeookk.',
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
  '.kkooweooewookk.',
  '.kkooeeooeeookk.',
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
  '.kkooweooewookk.',
  '.kkooeeooeeookk.',
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

const TCA: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooeeooeeookk.',
  '.kkooweooewookk.',
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

const TCB: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooeeooeeookk.',
  '.kkooweooewookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooowkkkk',
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
  '.kkooeeooeeookk.',
  '.kkooweooewookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkks...',
  '....kk....kk....'
];

const TSA: Frame = [
  '...o........o...',
  '..oo..kk....oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooweooewookk.',
  '.kkooeeooeeookk.',
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
  '...o........o...',
  '..oo...kkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooweooewookk.',
  '.kkooeeooeeookk.',
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
  '...o........o...',
  '..oo.....k..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooweooewookk.',
  '.kkooeeooeeookk.',
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
  '.kkooweooewookk.',
  '.kkooeeooeeookk.',
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
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooweooewookk.',
  '.kkooeeooeeookk.',
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
  '.kkooweowooookk.',
  '.kkooeeooeeookk.',
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
  '.kkooeeooeeookk.',
  '.kkooeeowoowokk.',
  '.kkooowrrwoookk.',
  'kkkoooooooo..kkk',
  'kkkkkooooo...kkk',
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
  '.kkooeeooeeookk.',
  '.kkooeeowoowokk.',
  '.kkooowrrwoookk.',
  'kkkooooooooo.kkk',
  'kkkkkoooooo..kkk',
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
  '.kkooeeooeeookk.',
  '.kkooeeowoowokk.',
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

const CDBB: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooeeooeeookk.',
  '.kkooeeowoowokk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooook.kkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CBRA: Frame = [
  '...o........o...',
  '..oo....kk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooeeooeeookk.',
  '.kkooeeowoowokk.',
  '.kkooowrrwoookk.',
  'kkkoooooooo..kkk',
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
  '.kkooeeooeeookk.',
  '.kkooeeowoowokk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkwooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const CLOa: Frame = [
  '...o.k......o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooeeooeeookk.',
  '.kkooeeowoowokk.',
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
  '...ok.......o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooeeooeeookk.',
  '.kkooeeowoowokk.',
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
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooeeooeeookk.',
  '.kkooeeowoowokk.',
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
  '...o............',
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
  '....kk....kk....',
  '....kk.....kk...'
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

const DCO: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooeeooeeookk.',
  '.kkoeeooeeeoekk.',
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
  '..ro........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooweooewookk.',
  '.kkooeeooeeookk.',
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
  'r..o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooweooewookk.',
  '.kkooeeooeeookk.',
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
  '.kkooweooewookk.',
  '.kkooeeooeeookk.',
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
  '.kkooweooewookk.',
  '.kkooeeooeeookk.',
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
  'o..o........o..o',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooweooewookk.',
  '.kkooeeooeeookk.',
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
  '.kkooweooewookk.',
  '.kkooeeooeeookk.',
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
  '.kkooweooewookk.',
  '.kkooeeooeeookk.',
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
  '.kkoowerrewookk.',
  '.kkooeerreeookk.',
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
  '.kkooweewewookk.',
  '.kkooeeeweeookk.',
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
  '.kkooweewewookk.',
  '.kkooeeeweeookk.',
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
  '.kkooweewewookk.',
  '.kkooeeeweeookk.',
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
  '..o.........o.o.',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooweooewookk.',
  '.kkooeeooeeookk.',
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
  '.kkooweooooookk.',
  '.kkoeeeooewookk.',
  '.kkooeeooeeookk.',
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
  '.kkoewoooooookk.',
  '.kkoeeeooewookk.',
  '.kkooeeooeeookk.',
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
  '.kkooweooewookk.',
  '.kkooeeooeeookk.',
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

const CGB: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooweooewookk.',
  '.kkooeeooeeookk.',
  '.kkooowrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooook.kkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const RCA: Frame = [
  '....o...........',
  '...o............',
  '..ook...........',
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
  '.kkoweoowewookk.',
  '.kkooeeooeeookk.',
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
  '.kkooeeooeeookk.',
  '.kkoweooweeookk.',
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
  '.kkooeeooeeookk.',
  '.kkooeeowoowokk.',
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
  '.kkoooweooewokk.',
  '.kkoooeeooeeokk.',
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
  '.kkoweooewoookk.',
  '.kkoeeooeeoookk.',
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
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooweooewookk.',
  '.kkooeeooeeookk.',
  '.kkooowwwwoookk.',
  'kkkooooooooookkk',
  'kookkooooookkook',
  'kookooooooookook',
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
  '.kkooeeooeeookk.',
  '.kkooweooewookk.',
  '.kkooowrrroookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkook',
  'kkkkooooooookook',
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
  '.kkooeeooeeookk.',
  '.kkooweooewookk.',
  '.kkooorrrwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkook',
  'kkkkooooooookook',
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
  '.kkoeeeooeeeokk.',
  '.kkoowrrrrwookk.',
  '.kkooooooooookkk',
  'kkkkkooooookkkkk',
  'kookooooooookook',
  'kookooooooookook',
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
  'ookoeeeooeeeokoo',
  'ookoowrrrrwookoo',
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
  'ooeooooooooooeoo',
  'ooeooooooooooeoo',
  '.eeoeeeooeeeoee.',
  '.eeoowrrrrwooee.',
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
  '.kkooweooewookk.',
  '.kkooeeooeeookk.',
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
  '.kkooweooewookk.',
  '.kkooeeooeeookk.',
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
  '.kkooeeooeeookk.',
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
  '.kkooeeooeeookk.',
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
  '.kkooweooewookk.',
  '.kkooeeooeeookk.',
  '.kkoowrrrrwookk.',
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
  '.kkooweooewookk.',
  '.kkooeeooeeookk.',
  '.kkoowrrrrwookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kkkkooooooookkkk',
  'kkkkooooooookkkk',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

// One dark bar across both eyes with slate arms at the temples — that is what
// reads as sunglasses at this size. The old frame drew two ordinary dark eye
// blocks with grey pixels beside them, which at 16 px looks like a normal face
// next to some noise, not like the state it is announcing.
const COA: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkseeesseeeskk.',
  '.kkoweeooeewokk.',
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
  '.kkooooooooookk.',
  '.kkseeesseeeskk.',
  '.kkoweerrrewokk.',
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
  '.kkoowerrewookk.',
  '.kkooeerreeookk.',
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
  '.kkooeeooeeookk.',
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
  '.kkooeeooeeookk.',
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
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowwoowwookk.',
  '.kkooeeooeeookk.',
  '.kkoowrrrrwookk.',
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
  '............o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkoowwoowwookk.',
  '.kkooeeooeeookk.',
  '.kkoowrrrrwookk.',
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
  '.kkooweooewookk.',
  '.kkooeeooeeookk.',
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
  '.kkooweooewookk.',
  '.kkooeeooeeookk.',
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
  '.kkooweooewookk.',
  '.kkooeeooeeookk.',
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

const MEDI1: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooooooooookk.',
  '.kkoeeeooeeeokk.',
  '.kkooowwwwoookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kookooooooookook',
  'kookooooooookook',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

const MEDI2: Frame = [
  '...o........o...',
  '..oo..kkkk..oo..',
  '..ookkkkkkkkoo..',
  '.kkkkkkkkkkkkkk.',
  '.kkooooooooookk.',
  '.kkooooooooookk.',
  '.kkoeeeooeeeokk.',
  '.kkoooowwooookk.',
  'kkkooooooooookkk',
  'kkkkkooooookkkkk',
  'kookooooooookook',
  'kookooooooookook',
  'kkkkkooooookkkkk',
  '.kkkkkkkkkkkkkk.',
  '....kkk..kkk....',
  '....kk....kk....'
];

export const VARIANTS: Record<MascotState, Frame[][]> = {
  idle:      [[SPA,SPA,SPA,IDLE_BLINK],[IMA,IMB],[IBA,IBB,IBC],[IBRA,IBRB],[ISA],[ISIT1,ISIT2]],
  typing:    [[TYPING],[TCA,TCB],[TCC]],
  thinking:  [[THINK_L,THINK_R],[TSA],[TRA,TRB],[TMG],[TQA],[TDF]],
  calling:   [[CALL_OUT,CALL_IN],[CFA,CFB],[CDBA,CDBB],[CBRA],[CAPIa],[CLOa,CLOb],[CHAa],[CCPA],[CTWA,CTWB]],
  done:      [[DONE],[DCO]],
  running:   [[RUN_A,RUN_B],[RCA],[RWA,RWB]],
  wave:      [[WAVE,WAVE_B],[WFA]],
  sleep:     [[SLEEP,SLEEP,SLEEP,SLEEP_B,SLEEP_B,SLEEP],[SLEEP,SZA,SZB,SZC,SZB,SZA],[SMO,SMO,SMO,SLEEP_B,SLEEP_B,SMO]],
  surprised: [[SURPRISED],[SXA],[SAA],[STA,STB]],
  curious:   [[SPA,CURIOUS,SPA,CURIOUS_L],[CUA,CUB],[CGA,CGB]],
  celebrate: [[CELEBRATE],[CFa,CFb],[CCFa,CCFb],[CSPa],[CFWa,CFWb]],
  reading:   [[RDA,RDB,RDC]],
  searching: [[SRA,SRB]],
  building:  [[BDA]],
  writing:   [[WRA,WRB]],
  stretching:[[STA1,STA2,STA3]],
  gaming:    [[GMA,GMB],[GRA,GRB]],
  love:      [[LOA,LOB]],
  cool:      [[COA],[CGA2]],
  error:     [[EXA],[EDA],[ESA]],
  excited:   [[EXC1,EXC2]],
  spawning:  [[SPA,SPB,SPC]],
  meditating:[[MEDI1,MEDI2]],
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
  meditating:VARIANTS.meditating[0],
};
