export type MascotState =
  | 'idle' | 'typing' | 'thinking' | 'calling' | 'done' | 'running'
  | 'wave' | 'sleep' | 'surprised' | 'curious' | 'celebrate'
  | 'reading' | 'searching' | 'building' | 'writing'
  | 'stretching' | 'gaming' | 'love' | 'cool' | 'error' | 'excited'
  | 'spawning' | 'dreaming';

export const FRAME_W = 32;
export const FRAME_H = 32;

const MASCOT_ORANGE = '#F57A1F';
export const PALETTE: Record<string, string | null> = {
  '.': null,
  k: '#1c1c1e', o: MASCOT_ORANGE, w: '#ffffff', r: '#c0392b',
  y: '#f1c40f', g: '#27ae60', b: '#2980b9', p: '#8e44ad',
  c: '#16a085', s: '#7f8c8d', n: '#e67e22', m: '#e91e63',
  // 32-bit shading ramp for the mascot body: highlight (d) and shadow (e),
  // plus a soft cheek blush (h) and dark-red mouth interior (t).
  d: '#ffb066', e: '#c2611a', h: '#f6a07a', t: '#7e2418',
  // Dark-fur body of the real Bloom mascot (charcoal monster, orange horns +
  // face + belly): fur base (f) and lit fur rim (l). `k` stays the darkest
  // outline / eye black.
  f: '#2d2d33', l: '#474750',
};

export type Frame = string[];

// The whole sprite is one approved BASE pose (pear-shaped dark-fur monster: small
// face high up, big bottom-heavy fluffy body, orange curved horns from a furry
// crown, orange belly, grey feet). Every other pose is BASE with a handful of
// pixels overwritten via px() — character stays identical across all 23 states
// and a body tweak happens in one place. Coordinate map (row,col): eyes rows10-11
// cols12-13 (left) / 18-19 (right); blush row12 cols11-12 / 19-20; mouth row13
// cols14-17 (fang w at 15); belly rows18-24; feet rows28-30 cols11-14 / 17-20.
const BASE: Frame = [
  '................................',
  '................................',
  '.........o............o.........',
  '........od....ffff....do........',
  '.......eoo..ffffffff..ooe.......',
  '.......eod.ffffffffff.doe.......',
  '........oolfffffffffffoo........',
  '.........lfffffffffffff.........',
  '.........lfooooooooooff.........',
  '........lffoooooooooofff........',
  '........lffowkoooowkofff........',
  '........lffokkooookkofff........',
  '.......lfffhhoooooohhffff.......',
  '.......lfffoootwrtoooffff.......',
  '.......lffffoooooooofffff.......',
  '......lfffffffffffffffffff......',
  '......lfffffffffffffffffff......',
  '.....lfffffffffffffffffffff.....',
  '.....lfffffffooooooffffffff.....',
  '....ffffffffoddoooooffffffff....',
  '....fffffffoooooooooofffffff....',
  '....fffffffoooooooooofffffff....',
  '....fffffffoooooooooofffffff....',
  '.....fffffffooeeeeoofffffff.....',
  '.....ffffffffooeeooffffffff.....',
  '......ffffffffffffffffffff......',
  '........ffffffffffffffff........',
  '..........ffffffffffff..........',
  '...........ffff..ffff...........',
  '...........llll..llll...........',
  '...........lkll..lkll...........',
  '................................',
];

type Edit = [number, number, string]; // row, col, char
/** BASE (or any frame) with the given cells overwritten — keeps 32×32 by construction. */
function px(base: Frame, ...edits: Edit[]): Frame {
  const rows = base.map((r) => r.split(''));
  for (const [r, c, ch] of edits) rows[r][c] = ch;
  return rows.map((r) => r.join(''));
}

const EYES_CLOSED: Edit[] = [
  [10, 12, 'o'], [10, 13, 'o'], [10, 18, 'o'], [10, 19, 'o'],
  [11, 12, 'k'], [11, 13, 'k'], [11, 18, 'k'], [11, 19, 'k'],
];
const SMILE_MOUTH: Edit[] = [
  [13, 13, 't'], [13, 14, 'r'], [13, 15, 'r'], [13, 16, 'r'], [13, 17, 'r'], [13, 18, 't'],
];

const N = BASE;
const BLINK = px(BASE, ...EYES_CLOSED);
const LOOK = px(BASE, [10, 12, 'o'], [10, 13, 'w'], [10, 18, 'o'], [10, 19, 'w']); // glance
const TALK = px(BASE, [13, 14, 't'], [13, 15, 'r'], [13, 16, 'r'], [13, 17, 't'], [14, 15, 't'], [14, 16, 't']);
const TALK2 = px(BASE, [13, 14, 't'], [13, 15, 't'], [13, 16, 't'], [13, 17, 't']);
const SMILE = px(BASE, ...SMILE_MOUTH);
const WIDE = px(BASE, [9, 12, 'k'], [9, 13, 'k'], [9, 18, 'k'], [9, 19, 'k'], [13, 15, 't'], [13, 16, 't'], [14, 15, 't'], [14, 16, 't']);
const HAPPY = px(BASE, ...EYES_CLOSED, ...SMILE_MOUTH);
const SLEEPY = px(BASE, ...EYES_CLOSED, [13, 14, 'o'], [13, 15, 'o'], [13, 16, 'o'], [13, 17, 'o']);
const SLEEPY_B = px(SLEEPY, [13, 15, 't'], [13, 16, 't'], [19, 14, 'd']);
const PAW = px(BASE, [9, 23, 'f'], [9, 24, 'f'], [8, 24, 'l'], [10, 23, 'f'], ...SMILE_MOUTH);
const PAW2 = px(BASE, [10, 23, 'f'], [10, 24, 'f'], [9, 24, 'l'], [11, 23, 'f'], ...SMILE_MOUTH);
const SHADE = px(BASE, // sunglasses bar over the eyes
  [10, 12, 'k'], [10, 13, 'w'], [10, 14, 'k'], [10, 15, 'k'], [10, 16, 'k'], [10, 17, 'k'], [10, 18, 'k'], [10, 19, 'k'],
  [11, 12, 'k'], [11, 19, 'k'], [13, 16, 't'], [13, 17, 'r'], [13, 18, 't']);
const XEYES = px(BASE,
  [10, 12, 't'], [10, 13, 'k'], [11, 12, 'k'], [11, 13, 't'],
  [10, 18, 'k'], [10, 19, 't'], [11, 18, 't'], [11, 19, 'k'],
  [13, 14, 't'], [13, 15, 't'], [13, 16, 't'], [13, 17, 't']);
const GAME = px(BASE, [19, 13, 'b'], [19, 14, 'b'], [19, 15, 'b'], [19, 16, 'b'], [20, 13, 'b'], [20, 16, 'b'], [13, 15, 't'], [13, 16, 't']);
const GAME2 = px(BASE, [19, 13, 'b'], [19, 14, 'b'], [19, 15, 'b'], [19, 16, 'b'], [20, 14, 'b'], [20, 15, 'b'], [13, 15, 't'], [13, 16, 't']);
const RUNB = px(BASE, [30, 12, 'l'], [30, 13, 'k'], [30, 18, 'l'], [30, 19, 'k']); // toe shift = leg cycle
const SIT = px(BASE, [30, 11, '.'], [30, 12, '.'], [30, 13, '.'], [30, 14, '.'], [30, 17, '.'], [30, 18, '.'], [30, 19, '.'], [30, 20, '.']);
const SIT2 = px(SIT, ...EYES_CLOSED);
const READ = px(BASE, [10, 12, 'o'], [10, 18, 'o'], [11, 12, 'w'], [11, 18, 'w']);
const READ2 = px(BASE, [10, 12, 'o'], [10, 18, 'o'], [11, 13, 'w'], [11, 19, 'w']);
const STR1 = px(BASE, [16, 3, 'l'], [16, 4, 'f'], [17, 4, 'f'], [16, 28, 'l'], [16, 27, 'f'], [17, 27, 'f'], ...SMILE_MOUTH);
const STR2 = px(BASE, [15, 3, 'l'], [15, 4, 'f'], [16, 4, 'f'], [15, 28, 'l'], [15, 27, 'f'], [16, 27, 'f'],
  [13, 15, 't'], [13, 16, 't'], [14, 15, 't'], [14, 16, 't']); // arms up + yawn
const STR3 = HAPPY;

export const VARIANTS: Record<MascotState, Frame[][]> = {
  idle:      [[N, N, N, BLINK], [N, N, BLINK, N], [N, BLINK, N, LOOK], [N, N, N, LOOK], [N, LOOK, N, BLINK], [N, N, SMILE, N], [SIT, SIT, SIT, SIT2]],
  typing:    [[TALK, TALK2], [TALK2, TALK], [TALK, N], [TALK2, SMILE]],
  thinking:  [[LOOK, N], [N, LOOK], [LOOK, BLINK], [N, LOOK], [LOOK, N], [BLINK, LOOK]],
  calling:   [[N, TALK], [TALK, N], [N, TALK2], [TALK2, N], [N, TALK], [TALK, N], [N, TALK2], [TALK, TALK2], [TALK2, TALK], [N, TALK]],
  done:      [[HAPPY, HAPPY], [HAPPY, SMILE], [HAPPY, HAPPY], [SMILE, HAPPY], [HAPPY, HAPPY], [HAPPY, SMILE]],
  running:   [[N, RUNB], [RUNB, N], [N, RUNB]],
  wave:      [[PAW, PAW2], [PAW2, PAW], [PAW, PAW2], [PAW2, PAW]],
  sleep:     [[SLEEPY, SLEEPY, SLEEPY_B, SLEEPY_B, SLEEPY], [SLEEPY, SLEEPY_B], [SLEEPY_B, SLEEPY, SLEEPY]],
  surprised: [[WIDE, WIDE], [WIDE, N], [WIDE, WIDE], [N, WIDE]],
  curious:   [[N, LOOK, N, BLINK], [LOOK, N], [N, LOOK, N, LOOK]],
  celebrate: [[HAPPY, SMILE], [SMILE, HAPPY], [HAPPY, SMILE], [SMILE, WIDE], [HAPPY, SMILE]],
  reading:   [[READ, READ2, READ]],
  searching: [[LOOK, N, BLINK]],
  building:  [[TALK, N]],
  writing:   [[TALK, N]],
  stretching:[[STR1, STR2, STR3]],
  gaming:    [[GAME, GAME2], [GAME2, GAME]],
  love:      [[HAPPY, HAPPY]],
  cool:      [[SHADE, SHADE], [SHADE, SMILE]],
  error:     [[XEYES, XEYES], [XEYES, N], [XEYES, XEYES]],
  excited:   [[WIDE, SMILE]],
  spawning:  [[N, SMILE]],
  // Dreaming reuses the sleeping body (same character) with the breathing loop;
  // the distinct dream wisps come from EFFECTS.dreaming.
  dreaming:  [[SLEEPY, SLEEPY_B]],
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
  dreaming:VARIANTS.dreaming[0],
};
