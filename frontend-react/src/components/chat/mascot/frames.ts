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
  // one colour cannot be both a visible body and a sharp pupil. The fill is
  // near-black, the way the reference draws it -- a black mass reads as fur
  // only if light catches its edges, so `R` is the rim: top and left outline
  // cells, drawn by the generator, never by hand. The silhouette test
  // measures the rim, not the fill; the fill is allowed to vanish, the edge
  // is not. `d` is fur in shadow and inner texture. The ink stays as black
  // as it ever was.
  k: '#0d0d11', e: '#1c1c1e', o: MASCOT_ORANGE, w: '#ffffff', r: '#c0392b',
  y: '#f1c40f', g: '#27ae60', b: '#2980b9', p: '#8e44ad',
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
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkoooweooooweoookkdd.....',
  '......Rdkoooeeooooeeoookkdd.....',
  '......Rdkoooowoooowooookkdd.....',
  '......Rdkkooooeeeeooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_IDLE_1: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkoooweooooweoookkdd.....',
  '......Rdkoooeeooooeeoookkdd.....',
  '......Rdkoooowoooowooookkdd.....',
  '......Rdkkooooeeeeooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_IDLE_2: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkoooeeooooeeoookkdd.....',
  '......Rdkoooowoooowooookkdd.....',
  '......Rdkkooooeeeeooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_IDLE_3: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkoooweooooweoookkdd.....',
  '......Rdkoooeeooooeeoookkdd.....',
  '......Rdkoooowoooowooookkdd.....',
  '......Rdkkooooeeeeooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_TYPING_0: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkoooweooooweoookkdd.....',
  '......Rdkoooeeooooeeoookkdd.....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkkooooeeeeooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_THINKING_0: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkooewwooooewwookkdd.....',
  '......Rdkooewwooooewwookkdd.....',
  '......Rdkooooeooooeooookkdd.....',
  '......Rdkkooooeeeeooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_THINKING_1: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkoowewoooowewookkdd.....',
  '......Rdkoowewoooowewookkdd.....',
  '......Rdkooooeooooeooookkdd.....',
  '......Rdkkooooeeeeooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_CALLING_0: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkeR......',
  '......Rdkkookooooookookeee......',
  '.....RdkkooooooooooooooeeeRR....',
  '......Rdkoooweooooweoooeeed.....',
  '......Rdkoooeeooooeeoooeeed.....',
  '......Rdkoooooeeeeoooooeeed.....',
  '......Rdkkooooerreooookkkdd.....',
  '......Rdkkkkoooeeoookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_CALLING_1: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkeR......',
  '......Rdkkookooooookookeee......',
  '.....RdkkooooooooooooooeeeRR....',
  '......Rdkoooweooooweoooeeed.....',
  '......Rdkoooeeooooeeoooeeed.....',
  '......Rdkooooeooooeooooeeed.....',
  '......Rdkkooooeeeeooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_DONE_0: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkoooeeooooeeoookkdd.....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkoooooeeeeoooookkdd.....',
  '......Rdkkooooerreooookkkdd.....',
  '......Rdkkkkoooeeoookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_RUNNING_0: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkoooeeooooeeoookkkRR....',
  '......Rdkoooweooooweoookkdd.....',
  '......Rdkoooeeooooeeoookkdd.....',
  '......Rdkooooeooooeooookkdd.....',
  '......Rdkkooooeeeeooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rddddddddddddkkkkkd......',
  '.......kkkkk........kkkkk.......',
  '.......kkkkk........kkkkk.......',
  '.......kkkkk....................',
];

const F32_RUNNING_1: Frame = [
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkoooeeooooeeoookkdd.....',
  '......Rdkoooweooooweoookkdd.....',
  '......Rdkoooeeooooeeoookkdd.....',
  '......Rdkkoooeooooeoookkkdd.....',
  '......Rdkkkkooeeeeookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rddddddddddkkkkkddd......',
  '........Rdddd.....kkkkkd........',
  '.........kkkkk....kkkkk.........',
  '.........kkkkk..................',
  '.........kkkkk..................',
];

const F32_WAVE_0: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkoooodoo......',
  '.......Rdkkkkkkkkkkkkkkdoo......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkoooweooooweoookkdd.....',
  '......Rdkoooeeooooeeoookkdd.....',
  '......Rdkoooooeeeeoooookkdd.....',
  '......Rdkkooooerreooookkkdd.....',
  '......Rdkkkkoooeeoookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_WAVE_1: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRooooo.......',
  '........Rooookkkkkkoooodoo......',
  '.......Rdkkkkkkkkkkkkkkdoo......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkoooweooooweoookkdd.....',
  '......Rdkoooeeooooeeoookkdd.....',
  '......Rdkoooooeeeeoooookkdd.....',
  '......Rdkkooooerreooookkkdd.....',
  '......Rdkkkkoooeeoookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_SLEEP_0: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkooowwwoowwwoookkdd.....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkkooooooooooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_SLEEP_1: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkooowwwoowwwoookkdd.....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkkooooooooooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_SLEEP_2: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkooowwwoowwwoookkdd.....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkkooooooooooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_SLEEP_3: Frame = [
  '................................',
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooowwwoowwwoookkkRR....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkkooooeeeeooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
];

const F32_SLEEP_4: Frame = [
  '................................',
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooowwwoowwwoookkkRR....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkkooooeeeeooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
];

const F32_SLEEP_5: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkooowwwoowwwoookkdd.....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkkooooooooooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_SURPRISED_0: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkoowwwoooowwwookkkRR....',
  '......Rdkooeewooooeewookkdd.....',
  '......Rdkooeewooooeewookkdd.....',
  '......Rdkoooooorrooooookkdd.....',
  '......Rdkkooooorroooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_CURIOUS_0: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkoooweooooweoookkdd.....',
  '......Rdkoooeeooooeeoookkdd.....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkkooooeeeeooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_CURIOUS_1: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkooooweooooweookkdd.....',
  '......Rdkooooeeooooeeookkdd.....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkkoooooeeeeoookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_CURIOUS_2: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkoooweooooweoookkdd.....',
  '......Rdkoooeeooooeeoookkdd.....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkkooooeeeeooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_CURIOUS_3: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkooweooooweooookkdd.....',
  '......Rdkooeeooooeeooookkdd.....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkkoooeeeeoooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_CELEBRATE_0: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '......ooRooookkkkkkoooodoo......',
  '......oodkkkkkkkkkkkkkkdoo......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkoooeeooooeeoookkdd.....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkooooeeeeeeooookkdd.....',
  '......Rdkkooooerreooookkkdd.....',
  '......Rdkkkkoooeeoookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_READING_0: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkoooeeooooeeoookkdd.....',
  '......Rdkoooweooooweoookkdd.....',
  '......Rdkkooooeeeeooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_READING_1: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkoooeeooooeeoookkdd.....',
  '......Rdkoooweooooweoookkdd.....',
  '......Rdkkooooeeeeooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_READING_2: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkoooeeooooeeoookkdd.....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkkooooeeeeooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_SEARCHING_0: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooeweeeeeeeeookkkRR....',
  '......Rdkooeeeeeeeweeookkdd.....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkkooooeeeeooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_SEARCHING_1: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooeeeweeeeeeookkkRR....',
  '......Rdkooeeeeeeeeewookkdd.....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkkooooeeeeooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_BUILDING_0: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkoooeeooooeeoookkkRR....',
  '......Rdkoooweooooweoookkdd.....',
  '......Rdkoooeeooooeeoookkdd.....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkkooooeeeeooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_WRITING_0: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkoooweooooweoookkdd.....',
  '......Rdkoooeeooooeeoookkdd.....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkkooooeeeeooookkkdd.....',
  '......Rdkkkkoowwwwookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkokkooooookkokkkdkdd...',
  '...RdkkkkkokkooooookkokkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_WRITING_1: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkoooweooooweoookkdd.....',
  '......Rdkoooeeooooeeoookkdd.....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkkooooeeeeooookkkdd.....',
  '......Rdkkkkoowwwwookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkko..ooooookkokkkdkdd...',
  '...RdkkkkkokkooooookkokkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_STRETCHING_0: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkoooweooooweoookkdd.....',
  '......Rdkoooeeooooeeoookkdd.....',
  '......Rdkooooeooooeooookkdd.....',
  '......Rdkkooooeeeeooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '....o.Rkkkkkkkkkkkkkkkkkkk.o....',
  '....okRkkkkkkkkkkkkkkkkkkkko....',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_STRETCHING_1: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkoooweooooweoookkdd.....',
  '......Rdkoooeeooooeeoookkdd.....',
  '......Rdkooooeooooeooookkdd.....',
  '......Rdkkooooeeeeooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '...o..Rkkkkkkkkkkkkkkkkkkk..o...',
  '...okkRkkkkkkkkkkkkkkkkkkkkko...',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_STRETCHING_2: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkoooweooooweoookkdd.....',
  '......Rdkoooeeooooeeoookkdd.....',
  '......Rdkooooeooooeooookkdd.....',
  '......Rdkkooooeeeeooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '..o...Rkkkkkkkkkkkkkkkkkkk...o..',
  '..okkkRkkkkkkkkkkkkkkkkkkkkkko..',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_GAMING_0: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkoooeeooooeeoookkkRR....',
  '......Rdkoooweooooweoookkdd.....',
  '......Rdkoooeeooooeeoookkdd.....',
  '......Rdkooooeooooeooookkdd.....',
  '......Rdkkooooeeeeooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkokkbbbbbbkkokkkdkdd...',
  '...RdkkkkkokkbybbwbkkokkkkkkdR..',
  '...Rdkkkkkooobbbbbboookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_GAMING_1: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkoooeeooooeeoookkkRR....',
  '......Rdkoooweooooweoookkdd.....',
  '......Rdkoooeeooooeeoookkdd.....',
  '......Rdkooooeooooeooookkdd.....',
  '......Rdkkooooeeeeooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkokkbbbbbbkkokkkdkdd...',
  '...RdkkkkkokkbbybwbkkokkkkkkdR..',
  '...Rdkkkkkooobbbbbboookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_LOVE_0: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkoooweooooweoookkdd.....',
  '......Rdkoooeeooooeeoookkdd.....',
  '......Rdkorrooeeeeoorrokkdd.....',
  '......Rdkkooooerreooookkkdd.....',
  '......Rdkkkkoooeeoookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_LOVE_1: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkoooeeooooeeoookkdd.....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkorrooeeeeoorrokkdd.....',
  '......Rdkkooooerreooookkkdd.....',
  '......Rdkkkkoooeeoookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_COOL_0: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkoeeweeeeeeweeokkkRR....',
  '......Rdkoeeeeeeeeeeeeokkdd.....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkkoooooeeeeoookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_ERROR_0: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkooeoeooooeoeookkdd.....',
  '......Rdkoooeooooooeoookkdd.....',
  '......Rdkooeoeoeoeeoeookkdd.....',
  '......Rdkkooooeoeoooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_EXCITED_0: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '......ooRooookkkkkkoooodoo......',
  '......oodkkkkkkkkkkkkkkdoo......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkoowwwoooowwwookkkRR....',
  '......Rdkooeewooooeewookkdd.....',
  '......Rdkooeewooooeewookkdd.....',
  '......Rdkoooooeeeeoooookkdd.....',
  '......Rdkkooooerreooookkkdd.....',
  '......Rdkkkkoooeeoookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_EXCITED_1: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkoowwwoooowwwookkkRR....',
  '......Rdkooeewooooeewookkdd.....',
  '......Rdkooeewooooeewookkdd.....',
  '......Rdkoooooeeeeoooookkdd.....',
  '......Rdkkooooerreooookkkdd.....',
  '......Rdkkkkoooeeoookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_SPAWNING_0: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkoooow........',
  '.......RykkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkooowwwoowwwoookkdd.....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkooooooooooooookkyd.....',
  '......Rdkkooooooooooookkkdd.....',
  '......wdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_SPAWNING_1: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkwR.......',
  '......RdkykkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkoooeeooooeeoookkdd.....',
  '......Rdkooooeooooeooookkdd.....',
  '......Rdkkooooeeeeooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_SPAWNING_2: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkoooweooooweoookkdd.....',
  '......Rdkoooeeooooeeoookkdd.....',
  '......Rdkoooowoooowooookkdd.....',
  '......Rdkkooooeeeeooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_MEDITATING_0: Frame = [
  '......oo................oo......',
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkoooeeeooeeeoookkdd.....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkkooooeeeeooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
];

const F32_MEDITATING_1: Frame = [
  '......oo................oo......',
  '......oooo............oooo......',
  '.......oooo..........oooo.......',
  '........ooooRRRRRRRRoooo........',
  '........Rooookkkkkkooood........',
  '.......RdkkkkkkkkkkkkkkdR.......',
  '......RdkkkkokkoookokkkkdR......',
  '......Rdkkookooooookookkdd......',
  '.....RdkkooooooooooooookkkRR....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkoooeeeooeeeoookkdd.....',
  '......Rdkooooooooooooookkdd.....',
  '......Rdkkooooeeeeooookkkdd.....',
  '......Rdkkkkooooooookkkkdd......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '......Rkkkkkkkkkkkkkkkkkkk......',
  '.....RddkkkkkkkkkkkkkkkkddR.....',
  '....RdkkkkkkkooooookkkkkkkdR....',
  '...RdkkkkkkooooooooookkkkkkdR...',
  '...Rdkdkkkooooooooooookkkdkdd...',
  '...RdkkkkkooooooooooookkkkkkdR..',
  '...Rdkkkkkooooooooooookkkkkkdd..',
  '..RdkkkdkkooooooooooookkdkkkkdR.',
  '...Rdkkkkkkooooooooookkkkkkdd...',
  '...Rdkkkkkkkkooooookkkkkkkkdd...',
  '....Rdkkkdkkkkkkkkkkkkdkkkdd....',
  '.....Rddddddddddddddddddddd.....',
  '.......Rdddddddddddddddddd......',
  '........Rdddd......Rdddd........',
  '........Rdddd......Rdddd........',
  '........Rd.Rd......Rd.Rd........',
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
