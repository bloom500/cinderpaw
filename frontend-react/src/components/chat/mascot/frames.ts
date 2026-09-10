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
const MASCOT_ORANGE = '#f2822c';
export const PALETTE: Record<string, string | null> = {
  '.': null,
  // `k` is FUR and `e` is the INK of a face feature: separate roles, because
  // one colour cannot be both a visible body and a sharp pupil. The fur is a
  // cool grey-black that holds a silhouette on the dark surface (2.02:1) and
  // on the light one (7.37:1); the ink stays as black as it ever was.
  // `d` is fur in shadow: outline cells and the tuft breaks inside the mass.
  // It earns its place the same way the fur did, by measurement in
  // frames.test.ts, not by looking right on one screen.
  k: '#4a4b53', e: '#1c1c1e', o: MASCOT_ORANGE, w: '#ffffff', r: '#c0392b',
  y: '#f1c40f', g: '#27ae60', b: '#2980b9', p: '#8e44ad',
  c: '#16a085', s: '#7f8c8d', n: '#e67e22', m: '#e91e63',
  d: '#31323a',
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
  const belly = 1 - Math.abs(row - 21) / 7;                             // peak mid-belly
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
























const F32_IDLE_0: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddoooweooooweoookdd......',
  '.....ddkkoooeeooooeeoookkkdd....',
  '.......ddoooowoooowooookdd......',
  '.....ddkkkooooeeeeooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_IDLE_1: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddoooweooooweoookdd......',
  '.....ddkkoooeeooooeeoookkkdd....',
  '.......ddoooowoooowooookdd......',
  '.....ddkkkooooeeeeooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_IDLE_2: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddooooooooooooookdd......',
  '.....ddkkoooeeooooeeoookkkdd....',
  '.......ddoooowoooowooookdd......',
  '.....ddkkkooooeeeeooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_IDLE_3: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddoooweooooweoookdd......',
  '.....ddkkoooeeooooeeoookkkdd....',
  '.......ddoooowoooowooookdd......',
  '.....ddkkkooooeeeeooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_TYPING_0: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddoooweooooweoookdd......',
  '.....ddkkoooeeooooeeoookkkdd....',
  '.......ddooooooooooooookdd......',
  '.....ddkkkooooeeeeooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_THINKING_0: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddooewwooooewwookdd......',
  '.....ddkkooewwooooewwookkkdd....',
  '.......ddooooeooooeooookdd......',
  '.....ddkkkooooeeeeooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_THINKING_1: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddoowewoooowewookdd......',
  '.....ddkkoowewoooowewookkkdd....',
  '.......ddooooeooooeooookdd......',
  '.....ddkkkooooeeeeooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_CALLING_0: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkedd.....',
  '.......ddkookooooookookeee......',
  '.....ddkkooooooooooooooeeedd....',
  '.......ddoooweooooweoooeee......',
  '.....ddkkoooeeooooeeoooeeedd....',
  '.......ddoooooeeeeoooooeee......',
  '.....ddkkkooooerreooookkkkdd....',
  '.......ddkkkoooeeoookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_CALLING_1: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkedd.....',
  '.......ddkookooooookookeee......',
  '.....ddkkooooooooooooooeeedd....',
  '.......ddoooweooooweoooeee......',
  '.....ddkkoooeeooooeeoooeeedd....',
  '.......ddooooeooooeooooeee......',
  '.....ddkkkooooeeeeooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_DONE_0: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddoooeeooooeeoookdd......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddoooooeeeeoooookdd......',
  '.....ddkkkooooerreooookkkkdd....',
  '.......ddkkkoooeeoookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_RUNNING_0: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkoooeeooooeeoookkkdd....',
  '.......ddoooweooooweoookdd......',
  '.....ddkkoooeeooooeeoookkkdd....',
  '.......ddooooeooooeooookdd......',
  '.....ddkkkooooeeeeooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddkkkkk.......',
  '.......kkkkk........kkkkk.......',
  '.......kkkkk........kkkkk.......',
  '.......kkkkk....................',
];

const F32_RUNNING_1: Frame = [
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddoooeeooooeeoookdd......',
  '.....ddkkoooweooooweoookkkdd....',
  '.......ddoooeeooooeeoookdd......',
  '.....ddkkkoooeooooeoookkkkdd....',
  '.......ddkkkooeeeeookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddkkkkkdd.......',
  '........ddddd.....kkkkkd........',
  '.........kkkkk....kkkkk.........',
  '.........kkkkk..................',
  '.........kkkkk..................',
];

const F32_WAVE_0: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdoo......',
  '........ddkkkkkkkkkkkkddoo......',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookddk......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddoooweooooweoookdd......',
  '.....ddkkoooeeooooeeoookkkdd....',
  '.......ddoooooeeeeoooookdd......',
  '.....ddkkkooooerreooookkkkdd....',
  '.......ddkkkoooeeoookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_WAVE_1: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.o.......',
  '.......ddkkkkkkkkkkkkkkdoo......',
  '........ddkkkkkkkkkkkkddoo......',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookddk......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddoooweooooweoookdd......',
  '.....ddkkoooeeooooeeoookkkdd....',
  '.......ddoooooeeeeoooookdd......',
  '.....ddkkkooooerreooookkkkdd....',
  '.......ddkkkoooeeoookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_SLEEP_0: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddooowwwoowwwoookdd......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddooooooooooooookdd......',
  '.....ddkkkooooooooooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_SLEEP_1: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddooowwwoowwwoookdd......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddooooooooooooookdd......',
  '.....ddkkkooooooooooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_SLEEP_2: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddooowwwoowwwoookdd......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddooooooooooooookdd......',
  '.....ddkkkooooooooooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_SLEEP_3: Frame = [
  '................................',
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooowwwoowwwoookkkdd....',
  '.......ddooooooooooooookdd......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddooooooooooooookdd......',
  '.....ddkkkooooeeeeooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
];

const F32_SLEEP_4: Frame = [
  '................................',
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooowwwoowwwoookkkdd....',
  '.......ddooooooooooooookdd......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddooooooooooooookdd......',
  '.....ddkkkooooeeeeooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
];

const F32_SLEEP_5: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddooowwwoowwwoookdd......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddooooooooooooookdd......',
  '.....ddkkkooooooooooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_SURPRISED_0: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkoowwwoooowwwookkkdd....',
  '.......ddooeewooooeewookdd......',
  '.....ddkkooeewooooeewookkkdd....',
  '.......ddoooooorrooooookdd......',
  '.....ddkkkooooorroooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_CURIOUS_0: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddoooweooooweoookdd......',
  '.....ddkkoooeeooooeeoookkkdd....',
  '.......ddooooooooooooookdd......',
  '.....ddkkkooooeeeeooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_CURIOUS_1: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddooooweooooweookdd......',
  '.....ddkkooooeeooooeeookkkdd....',
  '.......ddooooooooooooookdd......',
  '.....ddkkkoooooeeeeoookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_CURIOUS_2: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddoooweooooweoookdd......',
  '.....ddkkoooeeooooeeoookkkdd....',
  '.......ddooooooooooooookdd......',
  '.....ddkkkooooeeeeooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_CURIOUS_3: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddooweooooweooookdd......',
  '.....ddkkooeeooooeeooookkkdd....',
  '.......ddooooooooooooookdd......',
  '.....ddkkkoooeeeeoooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_CELEBRATE_0: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '......oodkkkkkkkkkkkkkkdoo......',
  '......ooddkkkkkkkkkkkkddoo......',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '......kddkookooooookookddk......',
  '.....ddkkooooooooooooookkkdd....',
  '......kddoooeeooooeeoookdd......',
  '.....ddkkooooooooooooookkkdd....',
  '......kddoooooeeeeoooookdd......',
  '.....ddkkkooooerreooookkkkdd....',
  '.......ddkkkoooeeoookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_READING_0: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddooooooooooooookdd......',
  '.....ddkkoooeeooooeeoookkkdd....',
  '.......ddoooweooooweoookdd......',
  '.....ddkkkooooeeeeooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_READING_1: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddooooooooooooookdd......',
  '.....ddkkoooeeooooeeoookkkdd....',
  '.......ddoooweooooweoookdd......',
  '.....ddkkkooooeeeeooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_READING_2: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddooooooooooooookdd......',
  '.....ddkkoooeeooooeeoookkkdd....',
  '.......ddooooooooooooookdd......',
  '.....ddkkkooooeeeeooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_SEARCHING_0: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooeweeeeeeeeookkkdd....',
  '.......ddooeeeeeeeweeookdd......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddooooooooooooookdd......',
  '.....ddkkkooooeeeeooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_SEARCHING_1: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooeeeweeeeeeookkkdd....',
  '.......ddooeeeeeeeeewookdd......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddooooooooooooookdd......',
  '.....ddkkkooooeeeeooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_BUILDING_0: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkoooeeooooeeoookkkdd....',
  '.......ddoooweooooweoookdd......',
  '.....ddkkoooeeooooeeoookkkdd....',
  '.......ddooooooooooooookdd......',
  '.....ddkkkooooeeeeooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_WRITING_0: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddoooweooooweoookdd......',
  '.....ddkkoooeeooooeeoookkkdd....',
  '.......ddooooooooooooookdd......',
  '.....ddkkkooooeeeeooookkkkdd....',
  '.......ddkkkoowwwwookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkokkooooookkokkkkdd....',
  '..ddkkkddkokkooooookkokkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_WRITING_1: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddoooweooooweoookdd......',
  '.....ddkkoooeeooooeeoookkkdd....',
  '.......ddooooooooooooookdd......',
  '.....ddkkkooooeeeeooookkkkdd....',
  '.......ddkkkoowwwwookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkko..ooooookkokkkkdd....',
  '..ddkkkddkokkooooookkokkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_STRETCHING_0: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddoooweooooweoookdd......',
  '.....ddkkoooeeooooeeoookkkdd....',
  '.......ddooooeooooeooookdd......',
  '.....ddkkkooooeeeeooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '....o.kkddkkkkkkkkkkkkkddk.o....',
  '....ok.kkkkkkkkkkkkkkkkkkkko....',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_STRETCHING_1: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddoooweooooweoookdd......',
  '.....ddkkoooeeooooeeoookkkdd....',
  '.......ddooooeooooeooookdd......',
  '.....ddkkkooooeeeeooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '...o..kkddkkkkkkkkkkkkkddk..o...',
  '...okk.kkkkkkkkkkkkkkkkkkkkko...',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_STRETCHING_2: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddoooweooooweoookdd......',
  '.....ddkkoooeeooooeeoookkkdd....',
  '.......ddooooeooooeooookdd......',
  '.....ddkkkooooeeeeooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '..o...kkddkkkkkkkkkkkkkddk...o..',
  '..okkk.kkkkkkkkkkkkkkkkkkkkkko..',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_GAMING_0: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkoooeeooooeeoookkkdd....',
  '.......ddoooweooooweoookdd......',
  '.....ddkkoooeeooooeeoookkkdd....',
  '.......ddooooeooooeooookdd......',
  '.....ddkkkooooeeeeooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkokkbbbbbbkkokkkkdd....',
  '..ddkkkddkokkbybbwbkkokkddkkkdd.',
  '....ddkkkkooobbbbbboookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_GAMING_1: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkoooeeooooeeoookkkdd....',
  '.......ddoooweooooweoookdd......',
  '.....ddkkoooeeooooeeoookkkdd....',
  '.......ddooooeooooeooookdd......',
  '.....ddkkkooooeeeeooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkokkbbbbbbkkokkkkdd....',
  '..ddkkkddkokkbbybwbkkokkddkkkdd.',
  '....ddkkkkooobbbbbboookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_LOVE_0: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddoooweooooweoookdd......',
  '.....ddkkoooeeooooeeoookkkdd....',
  '.......ddorrooeeeeoorrokdd......',
  '.....ddkkkooooerreooookkkkdd....',
  '.......ddkkkoooeeoookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_LOVE_1: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddoooeeooooeeoookdd......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddorrooeeeeoorrokdd......',
  '.....ddkkkooooerreooookkkkdd....',
  '.......ddkkkoooeeoookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_COOL_0: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkoeeweeeeeeweeokkkdd....',
  '.......ddoeeeeeeeeeeeeokdd......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddooooooooooooookdd......',
  '.....ddkkkoooooeeeeoookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_ERROR_0: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddooeoeooooeoeookdd......',
  '.....ddkkoooeooooooeoookkkdd....',
  '.......ddooeoeoeoeeoeookdd......',
  '.....ddkkkooooeoeoooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_EXCITED_0: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '......oodkkkkkkkkkkkkkkdoo......',
  '......ooddkkkkkkkkkkkkddoo......',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '......kddkookooooookookddk......',
  '.....ddkkoowwwoooowwwookkkdd....',
  '......kddooeewooooeewookdd......',
  '.....ddkkooeewooooeewookkkdd....',
  '......kddoooooeeeeoooookdd......',
  '.....ddkkkooooerreooookkkkdd....',
  '.......ddkkkoooeeoookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_EXCITED_1: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkoowwwoooowwwookkkdd....',
  '.......ddooeewooooeewookdd......',
  '.....ddkkooeewooooeewookkkdd....',
  '.......ddoooooeeeeoooookdd......',
  '.....ddkkkooooerreooookkkkdd....',
  '.......ddkkkoooeeoookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_SPAWNING_0: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkwd.......',
  '........ydkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddooowwwoowwwoookdd......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddooooooooooooookdy......',
  '.....ddkkkooooooooooookkkkdd....',
  '......wddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_SPAWNING_1: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdw........',
  '.....ddkkykkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddooooooooooooookdd......',
  '.....ddkkoooeeooooeeoookkkdd....',
  '.......ddooooeooooeooookdd......',
  '.....ddkkkooooeeeeooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_SPAWNING_2: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddoooweooooweoookdd......',
  '.....ddkkoooeeooooeeoookkkdd....',
  '.......ddoooowoooowooookdd......',
  '.....ddkkkooooeeeeooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_MEDITATING_0: Frame = [
  '................................',
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddooooooooooooookdd......',
  '.....ddkkoooeeeooeeeoookkkdd....',
  '.......ddooooooooooooookdd......',
  '.....ddkkkooooeeeeooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
];

const F32_MEDITATING_1: Frame = [
  '.......oo..............oo.......',
  '.......ooo............ooo.......',
  '........ooo..........ooo........',
  '.........oookkkkkkkkooo.........',
  '.......ddkkkkkkkkkkkkkkdd.......',
  '........ddkkkkkkkkkkkkdd........',
  '.....ddkkkkkokkoookokkkkkdd.....',
  '.......ddkookooooookookdd.......',
  '.....ddkkooooooooooooookkkdd....',
  '.......ddooooooooooooookdd......',
  '.....ddkkoooeeeooeeeoookkkdd....',
  '.......ddooooooooooooookdd......',
  '.....ddkkkooooeeeeooookkkkdd....',
  '.......ddkkkooooooookkkdd.......',
  '......kkddkkkkkkkkkkkkkddk......',
  '.......kkkkkkkkkkkkkkkkkkk......',
  '....ddkkkkkkkkkkkkkkkkkkkkdd....',
  '.....ddkkkkkkooooookkkkkkdd.....',
  '..ddkkddkkkooooooooookkkkddkdd..',
  '....ddkkkkooooooooooookkkkdd....',
  '..ddkkkddkooooooooooookkddkkkdd.',
  '....ddkkkkooooooooooookkkkkdd...',
  '..ddkkkkkkooooooooooookkkkkkkdd.',
  '....ddkddkkooooooooookkkdddd....',
  '..ddkkkkkkkkkooooookkkkkkkkkdd..',
  '.....ddkkkkkkkkkkkkkkkkkkdd.....',
  '....dddddddddddddddddddddddd....',
  '........ddddddddddddddddd.......',
  '........ddddd......ddddd........',
  '........ddddd......ddddd........',
  '........dd.dd......dd.dd........',
  '................................',
];

export const VARIANTS: Record<MascotState, Frame[][]> = {
  idle       : [[F32_IDLE_0,F32_IDLE_1,F32_IDLE_2,F32_IDLE_3]],
  typing     : [[F32_TYPING_0]],
  thinking   : [[F32_THINKING_0,F32_THINKING_1]],
  calling    : [[F32_CALLING_0,F32_CALLING_1]],
  done       : [[F32_DONE_0]],
  running    : [[F32_RUNNING_0,F32_RUNNING_1]],
  wave       : [[F32_WAVE_0,F32_WAVE_1]],
  sleep      : [[F32_SLEEP_0,F32_SLEEP_1,F32_SLEEP_2,F32_SLEEP_3,F32_SLEEP_4,F32_SLEEP_5]],
  surprised  : [[F32_SURPRISED_0]],
  curious    : [[F32_CURIOUS_0,F32_CURIOUS_1,F32_CURIOUS_2,F32_CURIOUS_3]],
  celebrate  : [[F32_CELEBRATE_0]],
  reading    : [[F32_READING_0,F32_READING_1,F32_READING_2]],
  searching  : [[F32_SEARCHING_0,F32_SEARCHING_1]],
  building   : [[F32_BUILDING_0]],
  writing    : [[F32_WRITING_0,F32_WRITING_1]],
  stretching : [[F32_STRETCHING_0,F32_STRETCHING_1,F32_STRETCHING_2]],
  gaming     : [[F32_GAMING_0,F32_GAMING_1]],
  love       : [[F32_LOVE_0,F32_LOVE_1]],
  cool       : [[F32_COOL_0]],
  error      : [[F32_ERROR_0]],
  excited    : [[F32_EXCITED_0,F32_EXCITED_1]],
  spawning   : [[F32_SPAWNING_0,F32_SPAWNING_1,F32_SPAWNING_2]],
  meditating : [[F32_MEDITATING_0,F32_MEDITATING_1]],
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
