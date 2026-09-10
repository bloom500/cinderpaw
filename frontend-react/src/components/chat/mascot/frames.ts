export type MascotState =
  | 'idle' | 'typing' | 'thinking' | 'calling' | 'done' | 'running'
  | 'wave' | 'sleep' | 'surprised' | 'curious' | 'celebrate'
  | 'reading' | 'searching' | 'building' | 'writing'
  | 'stretching' | 'gaming' | 'love' | 'cool' | 'error' | 'excited'
  | 'spawning' | 'meditating';

export const FRAME_W = 32;
export const FRAME_H = 32;

// Ember orange, matched to the site mascot. Bright enough that the face patch
// carries the creature on both app themes; the row ramp below does the rest.
const MASCOT_ORANGE = '#F9C180';
export const PALETTE: Record<string, string | null> = {
  '.': null,
  // `k` is the HOOD and `e` is the INK of a face feature: separate roles,
  // because one colour cannot be both a visible body and a sharp pupil. The
  // hood is dark grey off the spec sheet; the silhouette still lives in the
  // rim `R` (top and left outline), which the visibility test measures --
  // the fill is allowed to sit close to the dark surface, the edge is not.
  // `o` is SKIN (face and belly, beige), shaded per row by the ramp below.
  // `h` is horn brown, flat. `r` is blush pink. `d` is hood in shadow and
  // inner texture. The ink stays as black as it ever was.
  k: '#2C2C2C', e: '#1c1c1e', o: MASCOT_ORANGE, w: '#ffffff', r: '#FF9999',
  y: '#f1c40f', g: '#27ae60', b: '#2980b9', p: '#8e44ad',
  h: '#925321',
  c: '#16a085', s: '#7f8c8d', n: '#e67e22', m: '#e91e63',
  d: '#31323a', R: '#55555f',
};

// Body volume. The body char ('o') is the only large flat region; shading it by
// row fakes a top-lit, round body with a warm orange belly — so every one of
// the 50 frames gets dimension from one place instead of hand-painted shadows.
// ponytail: row ramp, not per-frame; the renderer swaps 'o' for BODY_SHADE[row].
// The two horns on rows 1-4 lean outward and root two cells deep in the fur.
// They read as horns because they narrow toward the tip, not as antennae, so
// please do not straighten or lengthen them without looking at the render.
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
  const t = Math.max(0, Math.min(1, (row - 4) / 24)); // 0 = horns .. 1 = feet
  let col = mix(MASCOT_ORANGE, '#f7c98d', Math.max(0, 0.32 - t * 0.36)); // upper highlight
  col = mix(col, '#6e3418', Math.max(0, t - 0.5) * 0.6);                 // lower core shadow
  const belly = 1 - Math.abs(row - 23) / 8;                             // peak mid-belly
  if (belly > 0) col = mix(col, '#f08c2e', belly * 0.35);               // warm orange belly
  return col;
});

export type Frame = string[];



























// Wide round eyes and a small open mouth. The previous frame differed from
// THINK_L by two pixels — both were "slightly asymmetric small eyes" — so the
// mascot looked identical whether it was thinking or startled, and two states
// that mean different things told the user the same thing.
























































































































































// One dark bar across both eyes with slate arms at the temples — that is what
// reads as sunglasses at this size. The old frame drew two ordinary dark eye
// blocks with grey pixels beside them, which at 16 px looks like a normal face
// next to some noise, not like the state it is announcing.




















































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































const F32_IDLE_0_0: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkooooweooooweooookkdd....',
  '.....Rdkooooeeooooeeooookkdd....',
  '.....Rdkoorrowooooworrookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '...RRkkkooooooooooooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_IDLE_0_1: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkooooweooooweooookkdd....',
  '.....Rdkooooeeooooeeooookkdd....',
  '.....Rdkoorrowooooworrookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '...RRkkkooooooooooooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_IDLE_0_2: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooeeooooeeooookkdd....',
  '.....Rdkoorrowooooworrookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '...RRkkkooooooooooooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_IDLE_0_3: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkooooweooooweooookkdd....',
  '.....Rdkooooeeooooeeooookkdd....',
  '.....Rdkoorrowooooworrookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '...RRkkkooooooooooooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_TYPING_0_0: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkooooweooooweooookkdd....',
  '.....Rdkooooeeooooeeooookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '...RRkkkooooooooooooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_THINKING_0_0: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkoooewwooooewwoookkdd....',
  '.....Rdkoooewwooooewwoookkdd....',
  '.....Rdkoooooeooooeoooookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '...RRkkkooooooooooooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_THINKING_0_1: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkooowewoooowewoookkdd....',
  '.....Rdkooowewoooowewoookkdd....',
  '.....Rdkoooooeooooeoooookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '...RRkkkooooooooooooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_THINKING_1_0: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooeeooooeeooookkdd....',
  '.....Rdkooobweooooweooookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '...RRkkkoooooeooooeoooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_CALLING_0_0: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkedR.....',
  '.....Rdkkooooooooooooooeeed.....',
  '.....RdkoooooooooooooooeeedR....',
  '.....Rdkooooweooooweoooeeedd....',
  '.....Rdkooooeeooooeeoooeeedd....',
  '.....Rdkooooooeeeeoooooeeedd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '...RRkkkoooooooeeoooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_CALLING_0_1: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkedR.....',
  '.....Rdkkooooooooooooooeeed.....',
  '.....RdkoooooooooooooooeeedR....',
  '.....Rdkooooweooooweoooeeedd....',
  '.....Rdkooooeeooooeeoooeeedd....',
  '.....Rdkoooooeooooeooooeeedd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '...RRkkkooooooooooooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_DONE_0_0: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkooooeeooooeeooookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '...RRkkkoooooooeeoooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_DONE_1_0: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh..oo...',
  '........hhhRRRRRRRRRRhhh...oo...',
  '........RdkkkkkkkkkkkkkdR..oo...',
  '.......RdkkkkkkkkkkkkkkkdR.kk...',
  '......RdkkkkkkkkkkkkkkkkkdRkk...',
  '.....Rdkkooooooooooooookkddkk...',
  '.....RdkooooooooooooooookkdRk...',
  '.....Rdkooooeeooooeeooookkddk...',
  '.....Rdkooooooooooooooookkddk...',
  '.....Rdkooooooeeeeooooookkddk...',
  '.....Rdkooooooeeeeooooookkddk...',
  '...RRkkkoooooooeeoooooookkk.....',
  '...Rdkkkooooooooooooooookkk.....',
  '...Rdkkkooooooooooooooookkk.....',
  '...Rdkkkkooooooooooooookkkk.....',
  '...Rdkkkkkkkkkkkkkkkkkkkkkk.....',
  '...Rdkkkkkkkkkkkkkkkkkkkkkk.....',
  '...Rdkkkkkkkooooooookkkkkkk.....',
  '...Rdkkkkkkooooooooookkkkkk.....',
  '...Rdkkkkkooooooooooookkkkk.....',
  '...Rdkkkkkooooooooooookkkkk.....',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_RUNNING_0_0: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooeeooooeeooookkdR....',
  '.....Rdkooooweooooweooookkdd....',
  '.....Rdkooooeeooooeeooookkdd....',
  '.....Rdkoooooeooooeoooookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '...RRkkkooooooooooooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rddddddddddddkkkkkd......',
  '.......kkkkk........kkkkk.......',
  '.......kkkkk........kkkkk.......',
  '.......kkkkk....................',
];

const F32_RUNNING_0_1: Frame = [
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkooooeeooooeeooookkdd....',
  '.....Rdkooooweooooweooookkdd....',
  '.....Rdkooooeeooooeeooookkdd....',
  '.....Rdkoooooeooooeoooookkdd....',
  '...RRkkkooooooeeeeooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rddddddddddkkkkkddd......',
  '........Rdddd.....kkkkkd........',
  '.........kkkkk....kkkkk.........',
  '.........kkkkk..................',
  '.........kkkkk..................',
];

const F32_WAVE_0_0: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh...oo...',
  '........RdkkkkkkkkkkkkkdR..oo...',
  '.......RdkkkkkkkkkkkkkkkdR.kk...',
  '......RdkkkkkkkkkkkkkkkkkdRkk...',
  '.....Rdkkooooooooooooookkddkk...',
  '.....RdkooooooooooooooookkdRk...',
  '.....Rdkooooweooooweooookkddk...',
  '.....Rdkooooeeooooeeooookkddk...',
  '.....Rdkooooooeeeeooooookkddk...',
  '.....Rdkooooooeeeeooooookkddk...',
  '...RRkkkoooooooeeoooooookkk.....',
  '...Rdkkkooooooooooooooookkk.....',
  '...Rdkkkooooooooooooooookkk.....',
  '...Rdkkkkooooooooooooookkkk.....',
  '...Rdkkkkkkkkkkkkkkkkkkkkkk.....',
  '...Rdkkkkkkkkkkkkkkkkkkkkkk.....',
  '...Rdkkkkkkkooooooookkkkkkk.....',
  '...Rdkkkkkkooooooooookkkkkk.....',
  '...Rdkkkkkooooooooooookkkkk.....',
  '...Rdkkkkkooooooooooookkkkk.....',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_WAVE_0_1: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh..o....',
  '........hhhRRRRRRRRRRhhh...oo...',
  '........RdkkkkkkkkkkkkkdR..oo...',
  '.......RdkkkkkkkkkkkkkkkdR.kk...',
  '......RdkkkkkkkkkkkkkkkkkdRkk...',
  '.....Rdkkooooooooooooookkddkk...',
  '.....RdkooooooooooooooookkdRk...',
  '.....Rdkooooweooooweooookkddk...',
  '.....Rdkooooeeooooeeooookkddk...',
  '.....Rdkooooooeeeeooooookkddk...',
  '.....Rdkooooooeeeeooooookkddk...',
  '...RRkkkoooooooeeoooooookkk.....',
  '...Rdkkkooooooooooooooookkk.....',
  '...Rdkkkooooooooooooooookkk.....',
  '...Rdkkkkooooooooooooookkkk.....',
  '...Rdkkkkkkkkkkkkkkkkkkkkkk.....',
  '...Rdkkkkkkkkkkkkkkkkkkkkkk.....',
  '...Rdkkkkkkkooooooookkkkkkk.....',
  '...Rdkkkkkkooooooooookkkkkk.....',
  '...Rdkkkkkooooooooooookkkkk.....',
  '...Rdkkkkkooooooooooookkkkk.....',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_SLEEP_0_0: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkoooowwwoowwwooookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '...RRkkkooooooooooooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_SLEEP_0_1: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkoooowwwoowwwooookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '...RRkkkooooooooooooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_SLEEP_0_2: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkoooowwwoowwwooookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '...RRkkkooooooooooooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_SLEEP_0_3: Frame = [
  '................................',
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkoooowwwoowwwooookkdR....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '...RRkkkooooooooooooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
];

const F32_SLEEP_0_4: Frame = [
  '................................',
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkoooowwwoowwwooookkdR....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '...RRkkkooooooooooooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
];

const F32_SLEEP_0_5: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkoooowwwoowwwooookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '...RRkkkooooooooooooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_SURPRISED_0_0: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooowwwoooowwwoookkdR....',
  '.....Rdkoooeewooooeewoookkdd....',
  '.....Rdkoooeewooooeewoookkdd....',
  '.....Rdkoooooooeeoooooookkdd....',
  '.....Rdkoooooooeeoooooookkdd....',
  '...RRkkkooooooooooooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_CURIOUS_0_0: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkooooweooooweooookkdd....',
  '.....Rdkooooeeooooeeooookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '...RRkkkooooooooooooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_CURIOUS_0_1: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkoooooweooooweoookkdd....',
  '.....Rdkoooooeeooooeeoookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkoooooooeeeeoooookkdd....',
  '...RRkkkooooooooooooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_CURIOUS_0_2: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkooooweooooweooookkdd....',
  '.....Rdkooooeeooooeeooookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '...RRkkkooooooooooooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_CURIOUS_0_3: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkoooweooooweoooookkdd....',
  '.....Rdkoooeeooooeeoooookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkoooooeeeeoooooookkdd....',
  '...RRkkkooooooooooooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_CELEBRATE_0_0: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '...oo...hhhRRRRRRRRRRhhh...oo...',
  '...oo...RdkkkkkkkkkkkkkdR..oo...',
  '...kk..RdkkkkkkkkkkkkkkkdR.kk...',
  '...kk.RdkkkkkkkkkkkkkkkkkdRkk...',
  '...kkRdkkooooooooooooookkddkk...',
  '...kkRdkooooooooooooooookkdRk...',
  '...kkRdkooooeeooooeeooookkddk...',
  '...kkRdkooooooooooooooookkddk...',
  '...kkRdkoooooeeeeeeoooookkddk...',
  '...kkRdkooooooeeeeooooookkddk...',
  '.....kkkoooooooeeoooooookkk.....',
  '.....kkkooooooooooooooookkk.....',
  '.....kkkooooooooooooooookkk.....',
  '.....kkkkooooooooooooookkkk.....',
  '.....kkkkkkkkkkkkkkkkkkkkkk.....',
  '.....kkkkkkkkkkkkkkkkkkkkkk.....',
  '.....kkkkkkkooooooookkkkkkk.....',
  '.....kkkkkkooooooooookkkkkk.....',
  '.....kkkkkooooooooooookkkkk.....',
  '.....kkkkkooooooooooookkkkk.....',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_READING_0_0: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooeeooooeeooookkdd....',
  '.....Rdkooooweooooweooookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '...RRkkkooooooooooooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_READING_0_1: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooeeooooeeooookkdd....',
  '.....Rdkooooweooooweooookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '...RRkkkooooooooooooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_READING_0_2: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooeeooooeeooookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '...RRkkkooooooooooooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_SEARCHING_0_0: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkoooeweeeeeeeeoookkdR....',
  '.....Rdkoooeeeeeeeweeoookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '...RRkkkooooooooooooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_SEARCHING_0_1: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkoooeeeweeeeeeoookkdR....',
  '.....Rdkoooeeeeeeeeewoookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '...RRkkkooooooooooooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_BUILDING_0_0: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooeeooooeeooookkdR....',
  '.....Rdkooooweooooweooookkdd....',
  '.....Rdkooooeeooooeeooookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '...RRkkkooooooooooooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_BUILDING_1_0: Frame = [
  '.............yyyyyy.............',
  '......hh....yyyyyyyy....hh......',
  '......hhh..nyyyyyyyyn..hhh......',
  '.......hhhyyyyyyyyyyyyhhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooeeooooeeooookkdR....',
  '.....Rdkooooweooooweooookkdd....',
  '.....Rdkooooeeooooeeooookkdd....',
  '.....Rdkooooooooooooooooksss....',
  '.....Rdkooooooeeeeooooooksds....',
  '...RRkkkooooooooooooooooksssR...',
  '...Rdkkkooooooooooooooookkssd...',
  '...Rdkkkooooooooooooooookkswd...',
  '...Rdkkkkooooooooooooookkkksd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkksd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkssd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_WRITING_0_0: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkooooweooooweooookkdd....',
  '.....Rdkooooeeooooeeooookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '.....kkkoooooowwwwooooookkk.....',
  '.....kkkooooooooooooooookkk.....',
  '.....kkkooooooooooooooookkk.....',
  '.....kkkkooooooooooooookkkk.....',
  '.....kkkkkkkkkkkkkkkkkkkkkk.....',
  '.....kkkkkkkkkkkkkkkkkkkkkk.....',
  '.....kkkkkkkkooooookkkkkkkk.....',
  '.....kkkkkkkkooooookkkkkkkk.....',
  '.....kkkkkooooooooooookkkkk.....',
  '.....kkkkkooooooooooookkkkk.....',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_WRITING_0_1: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkooooweooooweooookkdd....',
  '.....Rdkooooeeooooeeooookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '.....kkkoooooowwwwooooookkk.....',
  '.....kkkooooooooooooooookkk.....',
  '.....kkkooooooooooooooookkk.....',
  '.....kkkkooooooooooooookkkk.....',
  '.....kkkkkkkkkkkkkkkkkkkkkk.....',
  '.....kkkkkkkkkkkkkkkkkkkkkk.....',
  '.....kkkkkk..ooooookkkkkkkk.....',
  '.....kkkkkkkkooooookkkkkkkk.....',
  '.....kkkkkooooooooooookkkkk.....',
  '.....kkkkkooooooooooookkkkk.....',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_WRITING_1_0: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkooooweooooweooookkdd....',
  '.....Rdkooooeeooooeeooookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooooeeeeooooookyyd....',
  '...RRkkkoooooowwwwooooookyydR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkyydd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkyydd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkyydd...',
  '...Rdkkkkkkkooooooookkkkknndd...',
  '...Rdkkkkkkooooooooookkkkkedd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_STRETCHING_0_0: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkooooweooooweooookkdd....',
  '.....Rdkooooeeooooeeooookkdd....',
  '.....Rdkoooooeooooeoooookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '.....kkkooooooooooooooookkk.....',
  '...o.kkkooooooooooooooookkk.o...',
  '...o.kkkooooooooooooooookkk.o...',
  '.....kkkkooooooooooooookkkk.....',
  '.....kkkkkkkkkkkkkkkkkkkkkk.....',
  '.....kkkkkkkkkkkkkkkkkkkkkk.....',
  '.....kkkkkkkooooooookkkkkkk.....',
  '.....kkkkkkooooooooookkkkkk.....',
  '.....kkkkkooooooooooookkkkk.....',
  '.....kkkkkooooooooooookkkkk.....',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_STRETCHING_0_1: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkooooweooooweooookkdd....',
  '.....Rdkooooeeooooeeooookkdd....',
  '.....Rdkoooooeooooeoooookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '.....kkkooooooooooooooookkk.....',
  '..o..kkkooooooooooooooookkk..o..',
  '..ok.kkkooooooooooooooookkk.ko..',
  '.....kkkkooooooooooooookkkk.....',
  '.....kkkkkkkkkkkkkkkkkkkkkk.....',
  '.....kkkkkkkkkkkkkkkkkkkkkk.....',
  '.....kkkkkkkooooooookkkkkkk.....',
  '.....kkkkkkooooooooookkkkkk.....',
  '.....kkkkkooooooooooookkkkk.....',
  '.....kkkkkooooooooooookkkkk.....',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_STRETCHING_0_2: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkooooweooooweooookkdd....',
  '.....Rdkooooeeooooeeooookkdd....',
  '.....Rdkoooooeooooeoooookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '.....kkkooooooooooooooookkk.....',
  '.o...kkkooooooooooooooookkk...o.',
  '.okk.kkkooooooooooooooookkk.kko.',
  '.....kkkkooooooooooooookkkk.....',
  '.....kkkkkkkkkkkkkkkkkkkkkk.....',
  '.....kkkkkkkkkkkkkkkkkkkkkk.....',
  '.....kkkkkkkooooooookkkkkkk.....',
  '.....kkkkkkooooooooookkkkkk.....',
  '.....kkkkkooooooooooookkkkk.....',
  '.....kkkkkooooooooooookkkkk.....',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_GAMING_0_0: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooeeooooeeooookkdR....',
  '.....Rdkooooweooooweooookkdd....',
  '.....Rdkooooeeooooeeooookkdd....',
  '.....Rdkoooooeooooeoooookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '.....kkkooooooooooooooookkk.....',
  '.....kkkooooooooooooooookkk.....',
  '.....kkkooooooooooooooookkk.....',
  '.....kkkkooooooooooooookkkk.....',
  '.....kkkkkkkkkkkkkkkkkkkkkk.....',
  '.....kkkkkkkkkkkkkkkkkkkkkk.....',
  '.....kkkkkkkkbbbbbbkkkkkkkk.....',
  '.....kkkkkkkkbybbwbkkkkkkkk.....',
  '.....kkkkkooobbbbbboookkkkk.....',
  '.....kkkkkooooooooooookkkkk.....',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_GAMING_0_1: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooeeooooeeooookkdR....',
  '.....Rdkooooweooooweooookkdd....',
  '.....Rdkooooeeooooeeooookkdd....',
  '.....Rdkoooooeooooeoooookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '.....kkkooooooooooooooookkk.....',
  '.....kkkooooooooooooooookkk.....',
  '.....kkkooooooooooooooookkk.....',
  '.....kkkkooooooooooooookkkk.....',
  '.....kkkkkkkkkkkkkkkkkkkkkk.....',
  '.....kkkkkkkkkkkkkkkkkkkkkk.....',
  '.....kkkkkkkkbbbbbbkkkkkkkk.....',
  '.....kkkkkkkkbbybwbkkkkkkkk.....',
  '.....kkkkkooobbbbbboookkkkk.....',
  '.....kkkkkooooooooooookkkkk.....',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_LOVE_0_0: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkooooweooooweooookkdd....',
  '.....Rdkooooeeooooeeooookkdd....',
  '.....Rdkoorrooeeeeoorrookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '...RRkkkoooooooeeoooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_LOVE_0_1: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkooooeeooooeeooookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkoorrooeeeeoorrookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '...RRkkkoooooooeeoooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_COOL_0_0: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooeeweeeeeeweeookkdR....',
  '.....Rdkooeeeeeeeeeeeeookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkoooooooeeeeoooookkdd....',
  '...RRkkkooooooooooooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_ERROR_0_0: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkoooeoeooooeoeoookkdd....',
  '.....Rdkooooeooooooeooookkdd....',
  '.....Rdkoooeoeoeoeeoeoookkdd....',
  '.....Rdkooooooeoeoooooookkdd....',
  '...RRkkkooooooooooooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_ERROR_1_0: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooeeooooeeooookkdR....',
  '.....Rdkooooweooooweooookkdd....',
  '.....Rdkooooeeooooeeooookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '...RRkkkoooooeooooeoooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_EXCITED_0_0: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '...oo...hhhRRRRRRRRRRhhh...oo...',
  '...oo...RdkkkkkkkkkkkkkdR..oo...',
  '...kk..RdkkkkkkkkkkkkkkkdR.kk...',
  '...kk.RdkkkkkkkkkkkkkkkkkdRkk...',
  '...kkRdkkooooooooooooookkddkk...',
  '...kkRdkooowwwoooowwwoookkdRk...',
  '...kkRdkoooeewooooeewoookkddk...',
  '...kkRdkoooeewooooeewoookkddk...',
  '...kkRdkooooooeeeeooooookkddk...',
  '...kkRdkooooooeeeeooooookkddk...',
  '.....kkkoooooooeeoooooookkk.....',
  '.....kkkooooooooooooooookkk.....',
  '.....kkkooooooooooooooookkk.....',
  '.....kkkkooooooooooooookkkk.....',
  '.....kkkkkkkkkkkkkkkkkkkkkk.....',
  '.....kkkkkkkkkkkkkkkkkkkkkk.....',
  '.....kkkkkkkooooooookkkkkkk.....',
  '.....kkkkkkooooooooookkkkkk.....',
  '.....kkkkkooooooooooookkkkk.....',
  '.....kkkkkooooooooooookkkkk.....',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_EXCITED_0_1: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooowwwoooowwwoookkdR....',
  '.....Rdkoooeewooooeewoookkdd....',
  '.....Rdkoooeewooooeewoookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '...RRkkkoooooooeeoooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_SPAWNING_0_0: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkwR.......',
  '.......RykkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkoooowwwoowwwooookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooooooooooooookydd....',
  '.....Rdkooooooooooooooookkdd....',
  '...RRkwkooooooooooooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_SPAWNING_0_1: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkwdR......',
  '......RdkykkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooeeooooeeooookkdd....',
  '.....Rdkoooooeooooeoooookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '...RRkkkooooooooooooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_SPAWNING_0_2: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkooooweooooweooookkdd....',
  '.....Rdkooooeeooooeeooookkdd....',
  '.....Rdkooooowoooowoooookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '...RRkkkooooooooooooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_MEDITATING_0_0: Frame = [
  '................................',
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooeeeooeeeooookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '...RRkkkooooooooooooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_MEDITATING_0_1: Frame = [
  '......hh................hh......',
  '......hhh..............hhh......',
  '.......hhh............hhh.......',
  '........hhhRRRRRRRRRRhhh........',
  '........RdkkkkkkkkkkkkkdR.......',
  '.......RdkkkkkkkkkkkkkkkdR......',
  '......RdkkkkkkkkkkkkkkkkkdR.....',
  '.....Rdkkooooooooooooookkdd.....',
  '.....RdkooooooooooooooookkdR....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooeeeooeeeooookkdd....',
  '.....Rdkooooooooooooooookkdd....',
  '.....Rdkooooooeeeeooooookkdd....',
  '...RRkkkooooooooooooooookkkdR...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkooooooooooooooookkkdd...',
  '...Rdkkkkooooooooooooookkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkkkkkkkkkkkkkkkkdd...',
  '...Rdkkkkkkkooooooookkkkkkkdd...',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '...Rdkkkkkooooooooooookkkkkdd...',
  '....Rdkkkkooooooooooookkkkkdd...',
  '....Rdkkkkkooooooooookkkkkdd....',
  '.....Rdkkkkkooooooookkkkkkdd....',
  '......Rddddddoooooodddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
  '................................',
];

export const VARIANTS: Record<MascotState, Frame[][]> = {
  idle       : [[F32_IDLE_0_0,F32_IDLE_0_1,F32_IDLE_0_2,F32_IDLE_0_3]],
  typing     : [[F32_TYPING_0_0]],
  thinking   : [[F32_THINKING_0_0,F32_THINKING_0_1], [F32_THINKING_1_0]],
  calling    : [[F32_CALLING_0_0,F32_CALLING_0_1]],
  done       : [[F32_DONE_0_0], [F32_DONE_1_0]],
  running    : [[F32_RUNNING_0_0,F32_RUNNING_0_1]],
  wave       : [[F32_WAVE_0_0,F32_WAVE_0_1]],
  sleep      : [[F32_SLEEP_0_0,F32_SLEEP_0_1,F32_SLEEP_0_2,F32_SLEEP_0_3,F32_SLEEP_0_4,F32_SLEEP_0_5]],
  surprised  : [[F32_SURPRISED_0_0]],
  curious    : [[F32_CURIOUS_0_0,F32_CURIOUS_0_1,F32_CURIOUS_0_2,F32_CURIOUS_0_3]],
  celebrate  : [[F32_CELEBRATE_0_0]],
  reading    : [[F32_READING_0_0,F32_READING_0_1,F32_READING_0_2]],
  searching  : [[F32_SEARCHING_0_0,F32_SEARCHING_0_1]],
  building   : [[F32_BUILDING_0_0], [F32_BUILDING_1_0]],
  writing    : [[F32_WRITING_0_0,F32_WRITING_0_1], [F32_WRITING_1_0]],
  stretching : [[F32_STRETCHING_0_0,F32_STRETCHING_0_1,F32_STRETCHING_0_2]],
  gaming     : [[F32_GAMING_0_0,F32_GAMING_0_1]],
  love       : [[F32_LOVE_0_0,F32_LOVE_0_1]],
  cool       : [[F32_COOL_0_0]],
  error      : [[F32_ERROR_0_0], [F32_ERROR_1_0]],
  excited    : [[F32_EXCITED_0_0,F32_EXCITED_0_1]],
  spawning   : [[F32_SPAWNING_0_0,F32_SPAWNING_0_1,F32_SPAWNING_0_2]],
  meditating : [[F32_MEDITATING_0_0,F32_MEDITATING_0_1]],
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
