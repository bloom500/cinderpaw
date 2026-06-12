/**
 * Feral mascot sprite frames — v3 redesign (the real Feral monster).
 *
 * A 16x16 front-facing fluffy monster matching the brand figure: charcoal
 * black fur, orange horns, an orange face plate with big black eyes (white
 * glints), tiny white fangs, and a round orange belly. Built from one BASE
 * sprite plus pixel patches (P), horizontal shifts (SH) and a dissolve mask
 * (DIS). Drawing everything as patches over BASE keeps all 50+ variants
 * visually consistent: change BASE and the whole cast follows.
 *
 * Layout of BASE — rows 0-2 horns + head tuft | 3-9 head (face plate 4-9,
 * eyes 5-6, mouth 8-9) | 10-13 body (belly 11-13) | 14-15 feet. The fur is
 * kept a few steps above true black so the silhouette reads on the app's
 * dark background.
 *
 * Preview any change with: bun tools/render-mascot.ts <this file> out.png [state]
 */
export type MascotState =
  | 'idle' | 'typing' | 'thinking' | 'calling' | 'done' | 'running'
  | 'wave' | 'sleep' | 'surprised' | 'curious' | 'celebrate'
  | 'reading' | 'searching' | 'building' | 'writing'
  | 'stretching' | 'gaming' | 'love' | 'cool' | 'error' | 'excited'
  | 'spawning';

export const FRAME_W = 16;
export const FRAME_H = 16;

export const PALETTE: Record<string, string | null> = {
  '.': null,
  k: '#0E0C0A', // outline, pupils, mouth
  o: '#3B3734', // main fur (charcoal black, lifted to read on dark bg)
  d: '#262220', // fur shade
  h: '#4F4944', // fur highlight
  f: '#F57A1F', // face plate / belly (brand orange)
  w: '#FFFFFF', // eye whites, teeth, glints
  r: '#E84A4A', // tongue / mouth red
  y: '#FFD23F', // yellow accents (stars, sparks, pencil)
  g: '#3DDC84', // green accents (check, signal)
  b: '#4D9FFF', // blue accents (water, screen glow)
  p: '#B983FF', // purple accents (party, music)
  c: '#2EC4B6', // teal accents
  s: '#9AA0A6', // gray (Z's, smoke, steel)
  m: '#FF6B9D', // pink (hearts, blush)
  n: '#FF9D3B', // horn orange (lighter than the face plate)
  e: '#3A3F47', // dark slate (props: laptop, shades, pads)
};

export type Frame = string[];

const BASE: Frame = [
  '..n..........n..',
  '..nn.oooooo.nn..',
  '..onnoooooonno..',
  '..oooooooooooo..',
  '.oooooooooooood.',
  '.ooowkffffwkood.',
  '.oookkffffkkood.',
  '.oooffffffffood.',
  '.oooffwkkwffood.',
  '.ooofffrrfffood.',
  '..hooooooooood..',
  '..ooffffffffod..',
  '...offffffffd...',
  '...odffffffdo...',
  '....oo....oo....',
  '....dd....dd....',
];

type Edits = Array<[row: number, col: number, text: string]>;

/** Copy of `base` with `text` written at (row, col); out-of-grid chars dropped. */
function P(base: Frame, edits: Edits): Frame {
  const out = base.map((r) => r.split(''));
  for (const [row, col, text] of edits) {
    for (let i = 0; i < text.length; i++) {
      if (row >= 0 && row < FRAME_H && col + i >= 0 && col + i < FRAME_W) {
        out[row][col + i] = text[i];
      }
    }
  }
  return out.map((r) => r.join(''));
}

/** Shift rows [from..to] horizontally by dx (positive = right). */
function SH(base: Frame, from: number, to: number, dx: number): Frame {
  return base.map((row, i) => {
    if (i < from || i > to) return row;
    if (dx > 0) return '.'.repeat(dx) + row.slice(0, FRAME_W - dx);
    return row.slice(-dx) + '.'.repeat(-dx);
  });
}

/** Deterministic dissolve: keep ~ratio of pixels (spawn materialization). */
function DIS(base: Frame, ratio: number): Frame {
  return base.map((row, r) =>
    row
      .split('')
      .map((ch, c) => {
        if (ch === '.') return ch;
        return (r * 31 + c * 17 + 7) % 100 < ratio * 100 ? ch : '.';
      })
      .join(''),
  );
}

// --- face building blocks (coords on BASE) ----------------------------------
const E_BLINK: Edits = [[5, 4, 'oo'], [5, 10, 'oo'], [6, 4, 'kk'], [6, 10, 'kk']];
const E_HAPPY: Edits = [[5, 4, 'kk'], [5, 10, 'kk'], [6, 4, 'oo'], [6, 10, 'oo']];
const E_LOOK_L: Edits = [[6, 4, 'kw'], [6, 10, 'kw']];
const E_UP: Edits = [[5, 4, 'wk'], [5, 10, 'wk'], [6, 4, 'ww'], [6, 10, 'ww']];
const E_WIDE: Edits = [[4, 4, 'ww'], [4, 10, 'ww'], [5, 4, 'wk'], [5, 10, 'wk'], [6, 4, 'ww'], [6, 10, 'ww']];
const E_STAR: Edits = [[5, 4, 'yy'], [5, 10, 'yy'], [6, 4, 'yy'], [6, 10, 'yy']];
const E_HEART: Edits = [[5, 4, 'mm'], [5, 10, 'mm'], [6, 4, 'mm'], [6, 10, 'mm']];
const E_X: Edits = [[5, 4, 'rr'], [5, 10, 'rr'], [6, 4, 'rr'], [6, 10, 'rr']];
const M_SMILE: Edits = [[8, 6, 'kffk'], [9, 7, 'kk']];
const M_OPEN: Edits = [[8, 6, 'frrf'], [9, 7, 'rr']];
const M_FLAT: Edits = [[8, 6, 'fkkf'], [9, 7, 'ff']];
const M_GRIN: Edits = [[8, 6, 'wwww'], [9, 7, 'kk']];

// ================================================================ IDLE (5) ===
const I_BLINK = P(BASE, E_BLINK);
const I_LOOK_L = P(BASE, E_LOOK_L);
const I_HAPPY = P(BASE, [...E_HAPPY, ...M_SMILE]);
const I_NOTE_A = P(I_HAPPY, [[1, 14, 'p']]);
const I_NOTE_B = P(I_HAPPY, [[0, 13, 'p'], [2, 15, 'p']]);
const I_EARTW = P(BASE, [[0, 2, '.'], [0, 3, 'n']]); // left horn twitches
const I_YAWN = P(BASE, [...E_BLINK, ...M_OPEN]);

// ============================================================== TYPING (3) ===
const LAPTOP: Edits = [
  [11, 3, 'eebbbbbbee'],
  [12, 2, 'eeeeeeeeeeee'],
  [13, 2, 'eeeeeeeeeeee'],
];
const T_DOWN: Edits = [[6, 4, 'kw'], [6, 10, 'kw']]; // eyes toward screen
const TYPE_A = P(BASE, [...LAPTOP, ...T_DOWN]);
const TYPE_B = P(TYPE_A, [[11, 4, 'b'], [11, 9, 'b']]); // screen flicker
const TYPE_FOCUS_A = P(TYPE_A, [[4, 4, 'kk'], [4, 10, 'kk']]); // brows
const TYPE_FOCUS_B = P(TYPE_B, [[4, 4, 'kk'], [4, 10, 'kk']]);
const TYPE_FAST_A = P(TYPE_A, [[10, 0, 's'], [12, 15, 's']]);
const TYPE_FAST_B = P(TYPE_B, [[11, 0, 's'], [10, 15, 's']]);

// ============================================================ THINKING (4) ===
const TH_UP_L = P(BASE, [...E_UP, ...M_FLAT]);
const TH_UP_R = P(BASE, [[5, 4, 'kw'], [5, 10, 'kw'], [6, 4, 'ww'], [6, 10, 'ww'], ...M_FLAT]);
const TH_DOT1 = P(TH_UP_R, [[2, 14, 'y']]);
const TH_DOT2 = P(TH_UP_R, [[2, 14, 'y'], [1, 15, 'y']]);
const TH_DOT3 = P(TH_UP_R, [[2, 14, 'y'], [1, 15, 'y'], [0, 15, 'y']]);
const TH_CLD_A = P(TH_UP_L, [[2, 14, 'w'], [1, 12, 'www'], [0, 11, 'wwww']]);
const TH_CLD_B = P(TH_UP_L, [[2, 14, 'w'], [1, 11, 'wwww'], [0, 10, 'wwwww']]);
const TH_BULB_OFF = P(TH_UP_R, [[0, 7, 'ss'], [1, 7, 'ss']]);
const TH_BULB_ON = P(TH_UP_R, [[0, 7, 'yy'], [1, 7, 'yy'], [0, 5, 'y'], [0, 10, 'y']]);

// ============================================================= CALLING (4) ===
const CALL_BASE = P(BASE, [...M_FLAT, ...E_LOOK_L]);
const C_SIG_A = P(CALL_BASE, [[2, 0, 'b'], [1, 1, 'b'], [1, 14, 'b'], [2, 15, 'b']]);
const C_SIG_B = P(CALL_BASE, [
  [3, 0, 'b'], [1, 0, 'b'], [0, 1, 'b'],
  [0, 14, 'b'], [1, 15, 'b'], [3, 15, 'b'],
]);
const C_ANT_A = P(BASE, [[0, 13, 'g'], ...M_FLAT]); // ear-tip beacon
const C_ANT_B = P(BASE, [[0, 13, 'g'], [0, 12, 'g'], [1, 14, 'g'], ...M_FLAT]);
const C_PH_A = P(BASE, [...E_LOOK_L, [5, 13, 'ee'], [6, 13, 'ee'], [7, 13, 'ee']]); // phone at ear
const C_PH_B = P(C_PH_A, [[8, 6, 'fkrf']]); // talking
const C_PKT_A = P(CALL_BASE, [[1, 4, 'b']]);
const C_PKT_B = P(CALL_BASE, [[0, 8, 'b']]);
const C_PKT_C = P(CALL_BASE, [[1, 12, 'b']]);

// ================================================================ DONE (4) ===
const D_SMILE = P(BASE, [...E_HAPPY, ...M_SMILE]);
const D_CHECK_A = P(D_SMILE, [[1, 14, 'g'], [2, 15, 'g']]);
const D_CHECK_B = P(D_SMILE, [[2, 13, 'g'], [3, 14, 'g'], [1, 15, 'g']]);
const D_THUMB = P(D_SMILE, [[8, 13, 'oo'], [7, 14, 'o'], [9, 13, 'o']]); // paw up
const D_THUMB_B = P(D_SMILE, [[7, 13, 'oo'], [6, 14, 'o'], [8, 13, 'o']]); // pumped higher
const D_SPK_A = P(D_SMILE, [[0, 0, 'y'], [3, 15, 'y']]);
const D_SPK_B = P(D_SMILE, [[1, 1, 'w'], [2, 15, 'w'], [0, 5, 'y']]);
const D_PROUD = P(BASE, [...E_HAPPY, ...M_GRIN, [7, 1, 'mm'], [7, 13, 'mm']]);
const D_PROUD_B = P(D_PROUD, [[0, 0, 'y'], [1, 15, 'y']]);

// ============================================================= RUNNING (2) ===
// side pose, facing right (FeralMascot flips it when traveling left)
const RUN_1: Frame = [
  '................',
  '...n..n.........',
  '...oooooo.......',
  '..ooooooooo.....',
  '..ohoooofkfo....',
  '.dohoooofkfo....',
  '.dooooooofff....',
  '.ddooooooffwf...',
  '..oooooooooo....',
  '..dooffffood....',
  '...offffffd.....',
  '...doffffod.....',
  '....oo..oo......',
  '...oo....oo.....',
  '..dd......dd....',
  '................',
];
const RUN_2 = P(RUN_1, [
  [12, 0, '......oo..oo....'],
  [13, 0, '.....dd....dd...'],
  [14, 0, '................'],
]);
const DASH_1 = P(RUN_1, [[5, 0, 's'], [8, 0, 's'], [10, 0, 's']]);
const DASH_2 = P(RUN_2, [[4, 0, 's'], [7, 0, 's'], [11, 0, 's']]);

// ================================================================ WAVE (2) ===
// body shifted left one px so the waving paw gets a real 2px arm at the edge
const W_BODY = P(SH(BASE, 0, 15, -1), [
  ...E_HAPPY.map(([r, c, t]) => [r, c - 1, t] as [number, number, string]),
  ...M_SMILE.map(([r, c, t]) => [r, c - 1, t] as [number, number, string]),
]);
const W_UP = P(W_BODY, [[1, 14, 'oo'], [2, 14, 'oo'], [3, 14, 'of'], [4, 13, 'oo']]);
const W_DN = P(W_BODY, [[4, 14, 'oo'], [5, 14, 'of'], [6, 14, 'oo'], [7, 13, 'oo']]);
const W2_A = P(BASE, [...E_HAPPY, ...M_OPEN, [1, 0, 'oo'], [2, 0, 'oo'], [1, 14, 'oo'], [2, 14, 'oo']]);
const W2_B = P(BASE, [...E_HAPPY, ...M_OPEN, [3, 0, 'oo'], [4, 0, 'o'], [3, 14, 'oo'], [4, 15, 'o']]);

// =============================================================== SLEEP (3) ===
const SLP = P(BASE, [...E_BLINK, ...M_FLAT]);
const SLP_B = P(SLP, [[12, 2, 'o'], [12, 13, 'o']]); // belly out (breath)
const Z1 = P(SLP, [[1, 13, 's']]);
const Z2 = P(SLP, [[1, 13, 's'], [0, 14, 'ss']]);
const Z3 = P(SLP, [[0, 14, 'ss'], [2, 12, 's']]);
const DRM_A = P(SLP, [[0, 12, 'ww'], [1, 11, 'wmmw'], [2, 12, 'ww']]);
const DRM_B = P(SLP, [[0, 12, 'ww'], [1, 11, 'wmmw'], [2, 12, 'ww'], [3, 10, 'w']]);

// =========================================================== SURPRISED (2) ===
const SURP = P(BASE, [...E_WIDE, [8, 6, 'fkkf'], [9, 7, 'kk']]);
const SURP_B = P(SURP, [[5, 4, 'kw'], [5, 10, 'kw']]); // pupils jitter
const SURP_BANG_A = P(SURP, [[0, 7, 'y'], [1, 7, 'y']]);
const SURP_BANG_B = P(SURP, [[0, 7, 'y'], [1, 7, 'y'], [0, 5, 'y'], [0, 9, 'y']]);

// ============================================================= CURIOUS (3) ===
const TILT = SH(BASE, 0, 9, 1);
const CUR_A = P(BASE, E_LOOK_L);
const CUR_PEEK_A = P(TILT, [[4, 5, 'ww'], [4, 11, 'ww'], [5, 5, 'wk'], [5, 11, 'wk'], [6, 5, 'ww'], [6, 11, 'ww']]);
const CUR_PEEK_B = P(TILT, [[4, 5, 'ww'], [4, 11, 'ww'], [5, 5, 'kw'], [5, 11, 'kw'], [6, 5, 'ww'], [6, 11, 'ww']]);

// =========================================================== CELEBRATE (4) ===
const CEL = P(BASE, [...E_HAPPY, ...M_OPEN]);
const CEL_CONF_A = P(CEL, [[0, 0, 'y'], [1, 5, 'm'], [0, 9, 'b'], [2, 15, 'g'], [3, 0, 'p']]);
const CEL_CONF_B = P(CEL, [[1, 1, 'b'], [0, 6, 'g'], [1, 10, 'y'], [0, 14, 'm'], [4, 15, 'y']]);
const CEL_STAR_A = P(BASE, [...E_STAR, ...M_OPEN]);
const CEL_STAR_B = P(CEL_STAR_A, [[5, 4, 'yw'], [5, 10, 'yw']]);
const CEL_HAT_A = P(CEL, [[0, 6, '.yy.'], [1, 6, 'pppp'], [2, 6, 'pppp']]);
const CEL_HAT_B = P(CEL, [[0, 6, '.ww.'], [1, 6, 'pppp'], [2, 6, 'pppp']]);
const CEL_UP_A = P(CEL, [[2, 0, 'oo'], [3, 0, 'oo'], [2, 14, 'oo'], [3, 14, 'oo']]);
const CEL_UP_B = P(CEL, [[3, 0, 'oo'], [4, 0, 'oo'], [3, 14, 'oo'], [4, 14, 'oo']]);

// ============================================================= READING (2) ===
const BOOK: Edits = [
  [11, 3, 'wwwwkwwwww'],
  [12, 2, 'wwwwwkwwwwww'],
  [13, 2, 'bbbbbkbbbbbb'],
];
const RD_A = P(BASE, [...BOOK, ...T_DOWN]);
const RD_B = P(RD_A, [[6, 4, 'wk'], [6, 10, 'wk']]);
const RD_FLIP = P(RD_A, [[10, 7, 'w'], [11, 8, 'w']]);

// =========================================================== SEARCHING (2) ===
const MAG_L: Edits = [
  [4, 1, 'sss'], [5, 1, 's.s'], [6, 1, 'sss'], [7, 3, 'e'], [8, 4, 'e'],
  [5, 2, 'w'],
];
const SRCH_L = P(BASE, [...MAG_L, ...E_LOOK_L]);
const MAG_R: Edits = [
  [4, 12, 'sss'], [5, 12, 's.s'], [6, 12, 'sss'], [7, 11, 'e'], [8, 10, 'e'],
  [5, 13, 'w'],
];
const SRCH_R = P(BASE, MAG_R);
// paw shading the brow, eyes scanning the horizon
const SCOUT_A = P(BASE, [[4, 3, 'dddd'], [3, 7, 'o'], ...M_FLAT, ...E_LOOK_L]);
const SCOUT_B = P(BASE, [[4, 3, 'dddd'], [3, 7, 'o'], ...M_FLAT]);

// ============================================================ BUILDING (2) ===
const BLD_UP = P(BASE, [[2, 13, 'ss'], [3, 13, 'ss'], [4, 14, 'e'], [5, 14, 'e'], ...M_FLAT]);
const BLD_DN = P(BASE, [[8, 13, 'ss'], [9, 13, 'ss'], [7, 14, 'e'], [6, 14, 'e'], [10, 15, 'y'], ...M_FLAT]);
const WRN_A = P(BASE, [[5, 0, 's'], [6, 0, 's'], [7, 0, 's'], [4, 0, 's'], ...M_FLAT, ...E_LOOK_L]);
const WRN_B = P(BASE, [[6, 0, 's'], [7, 0, 's'], [8, 0, 's'], [5, 0, 's'], ...M_FLAT, ...E_LOOK_L]);

// ============================================================= WRITING (2) ===
const PEN_A: Edits = [[8, 13, 'y'], [9, 13, 'y'], [10, 13, 'n'], [11, 13, 'k']];
const PEN_B: Edits = [[8, 12, 'y'], [9, 12, 'y'], [10, 12, 'n'], [11, 12, 'k']];
const WRT_A = P(BASE, [...PEN_A, ...T_DOWN]);
const WRT_B = P(BASE, [...PEN_B, ...T_DOWN]);
const WRT_PAPER: Edits = [[12, 4, 'wwwwwwww'], [13, 4, 'wwwwwwww']];
const WRT_C = P(BASE, [...WRT_PAPER, ...PEN_A, ...T_DOWN]);
const WRT_D = P(BASE, [...WRT_PAPER, ...PEN_B, ...T_DOWN]);

// ========================================================== STRETCHING (2) ===
const STR_UP_A = P(BASE, [...E_BLINK, ...M_OPEN, [1, 0, 'oo'], [2, 0, 'oo'], [1, 14, 'oo'], [2, 14, 'oo']]);
const STR_UP_B = P(BASE, [...E_BLINK, ...M_OPEN, [0, 0, 'oo'], [1, 0, 'oo'], [0, 14, 'oo'], [1, 14, 'oo']]);
const LEAN_L = SH(BASE, 0, 7, -1);
const LEAN_R = SH(BASE, 0, 7, 1);

// ============================================================== GAMING (2) ===
const PAD: Edits = [[11, 4, 'eeeeeeee'], [12, 4, 'ee'], [12, 10, 'ee']];
const GM_A = P(BASE, [...PAD, ...T_DOWN, [11, 5, 'y'], [11, 10, 'b']]);
const GM_B = P(BASE, [...PAD, ...T_DOWN, [11, 6, 'g'], [11, 9, 'r']]);
const GM_LEAN_A = P(SH(BASE, 0, 9, -1), [...PAD, ...T_DOWN, [11, 5, 'y']]);
const GM_LEAN_B = P(SH(BASE, 0, 9, 1), [...PAD, ...T_DOWN, [11, 10, 'b']]);

// ================================================================ LOVE (2) ===
const LV_A = P(BASE, [...E_HEART, ...M_SMILE]);
const LV_B = P(LV_A, [[5, 4, 'mw'], [5, 10, 'mw']]);
const LV_FL_A = P(D_SMILE, [[1, 7, 'm.m'], [2, 7, 'mmm'], [3, 8, 'm']]);
const LV_FL_B = P(D_SMILE, [[0, 7, 'm.m'], [1, 7, 'mmm'], [2, 8, 'm']]);

// ================================================================ COOL (2) ===
const SHADES: Edits = [[5, 2, 'eeeeeeeeeeee'], [6, 3, 'ee'], [6, 9, 'ee']];
const CL_A = P(BASE, [...SHADES, ...M_FLAT]);
const CL_B = P(CL_A, [[5, 4, 'w'], [5, 10, 'w']]); // glint
const CL_SMIRK_A = P(BASE, [...SHADES, [8, 6, 'fkkf'], [9, 9, 'k'], [9, 8, 'o']]);
const CL_SMIRK_B = P(CL_SMIRK_A, [[5, 12, 'w']]);

// =============================================================== ERROR (3) ===
const ERR_X = P(BASE, [...E_X, ...M_FLAT]);
const ERR_X_B = P(ERR_X, [[0, 7, 'r'], [1, 7, 'r']]);
const DZ_A = P(BASE, [[5, 4, 'kw'], [5, 10, 'wk'], [6, 4, 'wk'], [6, 10, 'kw'], ...M_OPEN, [0, 4, 's'], [1, 10, 's']]);
const DZ_B = P(BASE, [[5, 4, 'wk'], [5, 10, 'kw'], [6, 4, 'kw'], [6, 10, 'wk'], ...M_OPEN, [0, 10, 's'], [1, 4, 's']]);
const SW_A = P(BASE, [...E_LOOK_L, ...M_FLAT, [4, 14, 'b']]);
const SW_B = P(BASE, [...E_LOOK_L, ...M_FLAT, [6, 14, 'b']]);

// ============================================================= EXCITED (2) ===
const EXC_A = P(BASE, [...E_WIDE, ...M_OPEN, [0, 0, 'y'], [1, 15, 'y']]);
const EXC_B = P(BASE, [...E_WIDE, ...M_OPEN, [1, 0, 'y'], [0, 15, 'y']]);
const EXC_BANG_A = P(BASE, [...E_WIDE, ...M_GRIN, [0, 2, 'y'], [1, 2, 'y'], [0, 13, 'y'], [1, 13, 'y']]);
const EXC_BANG_B = P(BASE, [...E_WIDE, ...M_GRIN, [1, 2, 'y'], [2, 2, 'y'], [1, 13, 'y'], [2, 13, 'y']]);

// ============================================================ SPAWNING (2) ===
const SPN_1 = DIS(BASE, 0.3);
const SPN_2 = DIS(BASE, 0.7);
const POP_A = P(DIS(BASE, 0.85), [[7, 0, 'w'], [7, 15, 'w'], [0, 7, 'w'], [15, 7, 'w']]);
const POP_B = P(BASE, [[6, 0, 'w'], [8, 15, 'w'], [0, 8, 'w']]);

// 55 variants total (50-60 target). Each inner array is one animation cycle.
export const VARIANTS: Record<MascotState, Frame[][]> = {
  idle: [
    [BASE, BASE, BASE, BASE, I_BLINK],
    [I_LOOK_L, I_LOOK_L, BASE, BASE],
    [I_NOTE_A, I_NOTE_B],
    [BASE, I_EARTW, BASE, BASE],
    [BASE, I_YAWN, I_YAWN, I_BLINK],
  ],
  typing: [
    [TYPE_A, TYPE_B],
    [TYPE_FOCUS_A, TYPE_FOCUS_B],
    [TYPE_FAST_A, TYPE_FAST_B],
  ],
  thinking: [
    [TH_UP_L, TH_UP_L, TH_UP_R, TH_UP_R],
    [TH_DOT1, TH_DOT2, TH_DOT3],
    [TH_CLD_A, TH_CLD_B],
    [TH_BULB_OFF, TH_BULB_ON, TH_BULB_ON],
  ],
  calling: [
    [C_SIG_A, C_SIG_B],
    [C_ANT_A, C_ANT_B],
    [C_PH_A, C_PH_B],
    [C_PKT_A, C_PKT_B, C_PKT_C],
  ],
  done: [
    [D_SMILE, D_CHECK_A, D_CHECK_B, D_CHECK_B],
    [D_THUMB, D_THUMB_B],
    [D_SPK_A, D_SPK_B],
    [D_PROUD, D_PROUD_B],
  ],
  running: [
    [RUN_1, RUN_2],
    [DASH_1, DASH_2],
  ],
  wave: [
    [W_UP, W_DN],
    [W2_A, W2_B],
  ],
  sleep: [
    [SLP, SLP, SLP_B, SLP_B],
    [Z1, Z2, Z3, Z3, Z2, Z1],
    [DRM_A, DRM_A, DRM_B, DRM_B],
  ],
  surprised: [
    [SURP, SURP_B],
    [SURP_BANG_A, SURP_BANG_B],
  ],
  curious: [
    [BASE, TILT, TILT, BASE],
    [CUR_A, CUR_A, BASE, BASE],
    [CUR_PEEK_A, CUR_PEEK_B],
  ],
  celebrate: [
    [CEL_CONF_A, CEL_CONF_B],
    [CEL_STAR_A, CEL_STAR_B],
    [CEL_HAT_A, CEL_HAT_B],
    [CEL_UP_A, CEL_UP_B],
  ],
  reading: [
    [RD_A, RD_A, RD_B, RD_B],
    [RD_A, RD_FLIP, RD_B],
  ],
  searching: [
    [SRCH_L, SRCH_L, SRCH_R, SRCH_R],
    [SCOUT_A, SCOUT_B],
  ],
  building: [
    [BLD_UP, BLD_DN],
    [WRN_A, WRN_B],
  ],
  writing: [
    [WRT_A, WRT_B],
    [WRT_C, WRT_D],
  ],
  stretching: [
    [STR_UP_A, STR_UP_B, STR_UP_B, STR_UP_A],
    [LEAN_L, BASE, LEAN_R, BASE],
  ],
  gaming: [
    [GM_A, GM_B],
    [GM_LEAN_A, GM_LEAN_B],
  ],
  love: [
    [LV_A, LV_B],
    [LV_FL_A, LV_FL_B],
  ],
  cool: [
    [CL_A, CL_A, CL_B, CL_A],
    [CL_SMIRK_A, CL_SMIRK_B],
  ],
  error: [
    [ERR_X, ERR_X_B],
    [DZ_A, DZ_B],
    [SW_A, SW_B],
  ],
  excited: [
    [EXC_A, EXC_B],
    [EXC_BANG_A, EXC_BANG_B],
  ],
  spawning: [
    [SPN_1, SPN_2, BASE],
    [SPN_1, POP_A, POP_B, BASE],
  ],
};

export const FRAMES: Record<MascotState, Frame[]> = {
  idle: VARIANTS.idle[0], typing: VARIANTS.typing[0], thinking: VARIANTS.thinking[0],
  calling: VARIANTS.calling[0], done: VARIANTS.done[0], running: VARIANTS.running[0],
  wave: VARIANTS.wave[0], sleep: VARIANTS.sleep[0], surprised: VARIANTS.surprised[0],
  curious: VARIANTS.curious[0], celebrate: VARIANTS.celebrate[0],
  reading: VARIANTS.reading[0], searching: VARIANTS.searching[0], building: VARIANTS.building[0],
  writing: VARIANTS.writing[0], stretching: VARIANTS.stretching[0], gaming: VARIANTS.gaming[0],
  love: VARIANTS.love[0], cool: VARIANTS.cool[0], error: VARIANTS.error[0],
  excited: VARIANTS.excited[0], spawning: VARIANTS.spawning[0],
};
