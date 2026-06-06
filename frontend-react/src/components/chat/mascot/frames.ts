export type MascotState = 'idle' | 'typing' | 'thinking' | 'calling' | 'done' | 'running';

export const FRAME_W = 16;
export const FRAME_H = 16;

/**
 * Mascot palette. Orange is a vivid toy-orange (matches the reference figure),
 * intentionally brighter than the muted brand `--brand` (#C4843A) so it reads at
 * 16px. Swap MASCOT_ORANGE to '#C4843A' if strict brand alignment is preferred.
 * `null` = transparent (pixel skipped when drawing).
 */
const MASCOT_ORANGE = '#F57A1F';
export const PALETTE: Record<string, string | null> = {
  '.': null,
  k: '#1c1c1e', // fur (near-black)
  o: MASCOT_ORANGE,
  w: '#ffffff', // eye highlights, fangs
  r: '#c0392b', // mouth interior
};

export type Frame = string[]; // FRAME_H strings, each FRAME_W chars

/** Idle, eyes-open, mouth smiling. The canonical silhouette all states derive from. */
const BASE: Frame = [
  '...o........o...', // 0  horn tips
  '..oo..kkkk..oo..', // 1  horns + fur crown
  '..ookkkkkkkkoo..', // 2  horns base + fur
  '.kkkkkkkkkkkkkk.', // 3  fur head
  '.kkooooooooookk.', // 4  face top
  '.kkoowkookwookk.', // 5  eyes top + white sparkle (top-outer)
  '.kkookkookkookk.', // 6  eyes (solid bottom)
  '.kkooowrrwoookk.', // 7  mouth (fangs + red)
  'kkkooooooooookkk', // 8  chin
  'kkkkkooooookkkkk', // 9  body + belly top
  'kkkkooooooookkkk', // 10 belly
  'kkkkooooooookkkk', // 11 belly (fuller)
  'kkkkkooooookkkkk', // 12 belly bottom (rounder)
  '.kkkkkkkkkkkkkk.', // 13 lower body
  '....kkk..kkk....', // 14 legs
  '....kk....kk....', // 15 feet
];

/** Return a copy of `base` with specific row indices replaced. */
function withRows(base: Frame, overrides: Record<number, string>): Frame {
  return base.map((row, i) => overrides[i] ?? row);
}

// Idle blink: eyes become a flat line, highlights gone.
const IDLE_BLINK = withRows(BASE, {
  5: '.kkooooooooookk.',
  6: '.kkookkookkookk.',
});

// Typing: looks down at the cursor — solid tops, sparkle drops to lower eye row.
const TYPING = withRows(BASE, {
  5: '.kkookkookkookk.',
  6: '.kkoowkookwookk.',
});

// Thinking: eyes dart left then right (pondering glance).
const THINK_L = withRows(BASE, { 5: '.kkoowkoowkookk.' });
const THINK_R = withRows(BASE, { 5: '.kkookwookwookk.' });

// Calling: eyes scan down, outer then inner (focused on work).
const CALL_OUT = withRows(BASE, { 5: '.kkookkookkookk.', 6: '.kkoowkookwookk.' });
const CALL_IN = withRows(BASE, { 5: '.kkookkookkookk.', 6: '.kkookwoowkookk.' });

// Done: happy closed eyes + a wider open smile.
const DONE = withRows(BASE, {
  5: '.kkooooooooookk.',
  6: '.kkookkookkookk.',
  7: '.kkoowrrrrwookk.',
});

// Running: side-profile silhouette. One horn, one eye, body in silhouette.
// `flip` prop on FeralMascot mirrors for the return trip (facing left).
const PROFILE_BASE: Frame = [
  '....o...........',  // 0  horn tip
  '...oo...........',  // 1  horn
  '..ookk..........',  // 2  horn base
  '.kkkkkk.........',  // 3  head
  '.kkooooooo......',  // 4  face (orange snout)
  '.kkoowooo.......',  // 5  eye + sparkle
  '.kkooooooo......',  // 6  face
  '.kkooowroo......',  // 7  mouth (fang + red)
  'kkooooooooo.....',  // 8  chin + belly start
  'kkoooooooooo....',  // 9  belly
  'kkoooooooooo....',  // 10 belly
  'kkkooooookkkk...',  // 11 lower body
  '..kkkkkkkkk.....',  // 12 legs base
  '....kk.kk.......',  // 13 upper legs
  '....kk....kk....',  // 14 lower legs
  '....kk.....kk...',  // 15 feet
];

const RUN_A = withRows(PROFILE_BASE, {
  14: '...kk...kk......',  // stride — front leg forward
  15: '..kk.....k......',
});
const RUN_B = withRows(PROFILE_BASE, {
  14: '...k....kk......',  // stride — back leg forward
  15: '...k.....kk.....',
});

export const FRAMES: Record<MascotState, Frame[]> = {
  idle: [BASE, BASE, BASE, IDLE_BLINK], // blink ~1 in 4 frames
  typing: [TYPING],
  thinking: [THINK_L, THINK_R],
  calling: [CALL_OUT, CALL_IN],
  done: [DONE, DONE],
  running: [RUN_A, RUN_B],
};
