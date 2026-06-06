export type MascotState = 'idle' | 'typing' | 'thinking' | 'calling' | 'done';

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
  '.kkookkookkookk.', // 5  eyes (solid)
  '.kkookwoowkookk.', // 6  eyes + white highlights
  '.kkooowrrwoookk.', // 7  mouth (fangs + red)
  'kkkooooooooookkk', // 8  chin
  'kkkkkooooookkkkk', // 9  body + belly top
  'kkkkooooooookkkk', // 10 belly
  'kkkkkooooookkkkk', // 11 belly
  'kkkkkkooookkkkkk', // 12 belly bottom
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

// Typing: looks down at the cursor — highlights drop to the lower eye row.
const TYPING = withRows(BASE, {
  5: '.kkookwoowkookk.',
  6: '.kkookkookkookk.',
});

// Thinking: glances up — highlights rise to the upper eye row.
const THINK_UP = withRows(BASE, {
  5: '.kkookwoowkookk.',
  6: '.kkookkookkookk.',
});
const THINK_FWD = BASE;

// Calling: scans left/right (eye highlights shift outward, then inward).
const CALL_OUT = withRows(BASE, { 6: '.kkoowkookwookk.' });
const CALL_IN = BASE;

// Done: happy closed eyes + a wider open smile.
const DONE = withRows(BASE, {
  5: '.kkooooooooookk.',
  6: '.kkookkookkookk.',
  7: '.kkoowrrrrwookk.',
});

export const FRAMES: Record<MascotState, Frame[]> = {
  idle: [BASE, BASE, BASE, IDLE_BLINK], // blink ~1 in 4 frames
  typing: [TYPING],
  thinking: [THINK_UP, THINK_FWD],
  calling: [CALL_OUT, CALL_IN],
  done: [DONE, DONE],
};
