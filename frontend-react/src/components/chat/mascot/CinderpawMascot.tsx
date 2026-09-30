import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import type { MascotState } from './frames';
import * as L from './lyingPose';
import './mascot.css';

/**
 * The creature, drawn as vectors.
 *
 * It used to be a 302-frame pixel sheet rendered out of Blender and blitted
 * onto a canvas. Every new state meant a new render and a regenerated sheet,
 * and a pose could only be as smooth as the frames someone drew. Here every
 * part (horns, head, eyes, each arm, the tail, the prop in its hands) is its
 * own SVG group, and a state is a combination of CSS classes: how the body
 * moves, what the arms do, how the eyes look, and what it holds. A new state
 * is a line in POSES, not a render.
 *
 * Drawn flat, after the character art: an orange hood of a head with a wide
 * cream face window, two black oval eyes and no mouth, rounded flame horns, a
 * cream belly, mitten arms and a curled tail. Depth comes only from one
 * darker orange for the creases (under the head, where limbs meet the body).
 *
 * The drawing is 128x132 with the soles at y=110, the same footprint the
 * sprite had, so the perch's placement above the composer still holds.
 */

/** Width at scale 1, and the drawing's own width. Height follows at 132/128. */
const BASE_W = 128;
const BASE_H = 132;

const C = {
  orange: '#F05A24',
  /** The art's second orange, on the horns, tail and limbs. */
  light: '#FB6226',
  crease: '#C8441E',
  cream: '#FBF1E4',
  eye: '#2A211C',
  lid: '#B8A497',
  lidDark: '#857268',
  metal: '#4A4F58',
};

/** Exported because the perch needs it too — the creature holding still while
 *  it is still being thrown the width of the composer is the setting
 *  half-honoured, which for a vestibular trigger is not honoured. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    // Optional-called, like the two other reduced-motion checks in this app:
    // an environment without `matchMedia` must lose the preference, not throw
    // and take the whole composer down with it.
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

// ── Poses ────────────────────────────────────────────────────────────────────

type Layout = 'stand' | 'sit' | 'lie';
type Eyes = 'open' | 'happy' | 'closed' | 'wide' | 'heart' | 'squeeze' | 'focused';
type Look = 'center' | 'down' | 'up' | 'side' | 'scan';
type Arms = 'rest' | 'wave' | 'up' | 'chin' | 'face' | 'front' | 'hold' | 'lap';
type Motion = 'breathe' | 'bob' | 'bounce' | 'jump' | 'shake' | 'sway' | 'sleep' | 'stretch' | 'jolt';
type Prop = 'book' | 'notepad' | 'gamepad' | 'magnifier' | 'headset' | 'sunglasses';
type Fx =
  | 'zzz' | 'question' | 'exclaim' | 'thought' | 'check' | 'confetti' | 'sparkles' | 'hearts'
  | 'sweat' | 'lock' | 'hourglass' | 'gear' | 'blocks' | 'calendar' | 'database' | 'talkwaves'
  | 'listenwaves' | 'mini' | 'lines';

interface Pose {
  /** 'lie' is the traced laptop scene (lyingPose.ts); it brings its own laptop. */
  layout?: Layout;
  eyes: Eyes;
  look?: Look;
  arms: Arms;
  motion: Motion;
  /** Degrees the head leans; negative is towards the viewer's left. */
  tilt?: number;
  props?: Prop[];
  fx?: Fx[];
  nod?: boolean;
  wiggle?: boolean;
  wag?: boolean;
}

const POSES: Record<MascotState, Pose> = {
  idle:       { eyes: 'open', arms: 'rest', motion: 'breathe', wag: true },
  typing:     { layout: 'lie', eyes: 'open', arms: 'rest', motion: 'breathe', wag: true },
  thinking:   { eyes: 'open', look: 'up', arms: 'chin', motion: 'sway', tilt: -8, fx: ['thought'] },
  calling:    { eyes: 'open', arms: 'rest', motion: 'bob', props: ['headset'], fx: ['talkwaves'] },
  done:       { eyes: 'happy', arms: 'rest', motion: 'bounce', fx: ['check'], nod: true, wag: true },
  running:    { layout: 'lie', eyes: 'focused', arms: 'rest', motion: 'breathe', fx: ['gear'], wag: true },
  wave:       { eyes: 'happy', arms: 'wave', motion: 'breathe', tilt: 5, wag: true },
  sleep:      { layout: 'sit', eyes: 'closed', arms: 'lap', motion: 'sleep', tilt: -6, fx: ['zzz'] },
  surprised:  { eyes: 'wide', arms: 'face', motion: 'jolt', fx: ['lines'], wiggle: true },
  curious:    { eyes: 'wide', look: 'side', arms: 'chin', motion: 'breathe', tilt: 8 },
  celebrate:  { eyes: 'happy', arms: 'up', motion: 'jump', tilt: -5, fx: ['confetti'], wiggle: true, wag: true },
  reading:    { layout: 'sit', eyes: 'open', look: 'down', arms: 'front', motion: 'breathe', props: ['book'] },
  searching:  { eyes: 'wide', look: 'scan', arms: 'hold', motion: 'breathe', tilt: 4, props: ['magnifier'] },
  building:   { layout: 'lie', eyes: 'focused', arms: 'rest', motion: 'breathe', fx: ['blocks'] },
  writing:    { layout: 'sit', eyes: 'open', look: 'down', arms: 'front', motion: 'breathe', props: ['notepad'] },
  stretching: { eyes: 'closed', arms: 'up', motion: 'stretch' },
  gaming:     { layout: 'sit', eyes: 'focused', arms: 'front', motion: 'bob', props: ['gamepad'] },
  love:       { eyes: 'heart', arms: 'face', motion: 'bounce', tilt: -6, fx: ['hearts'], wag: true },
  cool:       { eyes: 'open', arms: 'rest', motion: 'sway', props: ['sunglasses'], nod: true },
  error:      { eyes: 'squeeze', arms: 'face', motion: 'shake', fx: ['sweat'] },
  excited:    { eyes: 'happy', arms: 'up', motion: 'jump', fx: ['lines', 'sparkles'], wiggle: true, wag: true },
  spawning:   { eyes: 'happy', arms: 'wave', motion: 'bounce', fx: ['mini'] },
  asking:     { eyes: 'wide', arms: 'chin', motion: 'breathe', tilt: 9, fx: ['question'] },
  waiting:    { eyes: 'open', look: 'up', arms: 'rest', motion: 'breathe', fx: ['hourglass'], wag: true },
  speaking:   { eyes: 'happy', arms: 'rest', motion: 'bob', fx: ['talkwaves'] },
  listening:  { eyes: 'open', arms: 'rest', motion: 'breathe', tilt: 6, props: ['headset'], fx: ['listenwaves'] },
  blocked:    { eyes: 'open', look: 'down', arms: 'rest', motion: 'breathe', fx: ['lock'] },
  scheduling: { eyes: 'open', look: 'up', arms: 'rest', motion: 'breathe', fx: ['calendar'] },
  storing:    { eyes: 'happy', arms: 'rest', motion: 'breathe', fx: ['database'] },
};

// ── Geometry ─────────────────────────────────────────────────────────────────
// Paths use absolute M/L/C commands only, so `mirror` can flip the left half
// of the drawing into the right one.

function mirror(d: string): string {
  let axis = 0;
  return d.replace(/([MLCZ])|(-?\d*\.?\d+)/g, (tok, cmd: string | undefined) => {
    if (cmd) { axis = 0; return tok; }
    const out = axis % 2 === 0 ? String(+(BASE_W - Number(tok)).toFixed(2)) : tok;
    axis += 1;
    return out;
  });
}

const HEAD = 'M64 24 C85.5 24 99 33 99 48.5 C99 64.5 85 74.5 64 74.5 C43 74.5 29 64.5 29 48.5 C29 33 42.5 24 64 24 Z';
const FACE =
  'M50 35.6 C59 34.6 69 34.6 78 35.6 C87.5 36.6 92.2 41.5 92.2 49.5 C92.2 59 86.8 67.6 78 68.4 ' +
  'C69 69.2 59 69.2 50 68.4 C41.2 67.6 35.8 59 35.8 49.5 C35.8 41.5 40.5 36.6 50 35.6 Z';
/** A flame: a round bulb at the outer root, a thin stem rising from it and a
 *  soft tip leaning back over the head. Both edges under the tip are concave. */
const HORN_L =
  'M44 31.5 C41.6 28 39.8 23.5 39.4 19 C39.2 16.8 39.4 15 38.4 14.2 C37.3 13.3 35.8 14 35.3 15.8 ' +
  'C34.6 18.4 33.6 20.6 31.2 22.6 C26.8 25.6 24.2 29.8 25.6 34 C27.2 38.4 33.4 39 38.4 36.6 Z';
const HORN_R = mirror(HORN_L);
/** Standing body and legs, one outline: narrow at the neck, wide at the hips. */
const BODY =
  'M48 70 C44.5 79 41.6 88 41.6 96 C41.6 101 42 105.6 43.2 108.4 C44 110.1 45.8 110.6 48 110.6 L55.4 110.6 ' +
  'C57.6 110.6 59 109.6 59.4 107.6 L60.2 104.2 C60.6 102.6 62.2 101.8 64 101.8 C65.8 101.8 67.4 102.6 67.8 104.2 ' +
  'L68.6 107.6 C69 109.6 70.4 110.6 72.6 110.6 L80 110.6 C82.2 110.6 84 110.1 84.8 108.4 ' +
  'C86 105.6 86.4 101 86.4 96 C86.4 88 83.5 79 80 70 Z';
const BELLY = 'M64 77.5 C70.5 77.5 75.8 84.2 76.2 91 C76.6 97.4 71.5 100.8 64 100.8 C56.5 100.8 51.4 97.4 51.8 91 C52.2 84.2 57.5 77.5 64 77.5 Z';
const NECK = 'M47 70 C53 77 75 77 81 70 L81.4 72.6 C75 80 53 80 46.6 72.6 Z';
const TAIL =
  'M46 99.5 C39.5 102.8 29.6 102.6 25.4 97.2 C22 92.8 22.6 85.6 26.4 82 C28.4 80.2 31.8 80.6 32.4 83.2 ' +
  'C33 85.8 31.8 88.6 33.6 90.6 C36 93 41 91.8 45.6 88.8 Z';

const SIT_BODY = 'M46 76 C42 84 40.5 94 42.5 101 C44 106.5 50 109.5 64 109.5 C78 109.5 84 106.5 85.5 101 C87.5 94 86 84 82 76 Z';
const SIT_BELLY = 'M64 84.5 C69 84.5 73 90.5 73 97 C73 102.5 69.5 106 64 106 C58.5 106 55 102.5 55 97 C55 90.5 59 84.5 64 84.5 Z';

// ── Parts ────────────────────────────────────────────────────────────────────

const origin = (x: number, y: number) => ({ '--px': `${x}px`, '--py': `${y}px` }) as CSSProperties;

function sparklePath(x: number, y: number, r: number): string {
  const k = r * 0.22;
  return `M${x} ${y - r} C${x + k} ${y - k} ${x + k} ${y - k} ${x + r} ${y} C${x + k} ${y + k} ${x + k} ${y + k} ${x} ${y + r} ` +
    `C${x - k} ${y + k} ${x - k} ${y + k} ${x - r} ${y} C${x - k} ${y - k} ${x - k} ${y - k} ${x} ${y - r}Z`;
}

function heartPath(x: number, y: number, s: number): string {
  return `M${x} ${y + s * 0.9} C${x - s * 1.4} ${y} ${x - s * 0.9} ${y - s * 1.1} ${x} ${y - s * 0.35} ` +
    `C${x + s * 0.9} ${y - s * 1.1} ${x + s * 1.4} ${y} ${x} ${y + s * 0.9}Z`;
}

/** A limb with its crease: the same shape in the darker orange, nudged
 *  towards the body, then the limb itself on top. */
function Limb({ cx, cy, rx, ry, rot, dx = 0, dy = 0 }: { cx: number; cy: number; rx: number; ry: number; rot: number; dx?: number; dy?: number }) {
  return (
    <g>
      <ellipse cx={cx + dx} cy={cy + dy} rx={rx} ry={ry} transform={`rotate(${rot} ${cx + dx} ${cy + dy})`} fill={C.crease} />
      <ellipse cx={cx} cy={cy} rx={rx} ry={ry} transform={`rotate(${rot} ${cx} ${cy})`} fill={C.light} />
    </g>
  );
}

function Eye({ x, kind }: { x: number; kind: Eyes }) {
  const y = 53;
  if (kind === 'happy') {
    return <path d={`M${x - 6.6} ${y + 2.8} C${x - 6} ${y - 4.8} ${x + 6} ${y - 4.8} ${x + 6.6} ${y + 2.8}`} fill="none" stroke={C.eye} strokeWidth={3.2} strokeLinecap="round" />;
  }
  if (kind === 'closed') {
    return <path d={`M${x - 5.6} ${y} C${x - 4.8} ${y + 5} ${x + 4.8} ${y + 5} ${x + 5.6} ${y}`} fill="none" stroke={C.eye} strokeWidth={2.6} strokeLinecap="round" />;
  }
  if (kind === 'squeeze') {
    const s = x < 64 ? 1 : -1;
    return <path d={`M${x - 3.6 * s} ${y - 4} L${x + 3.2 * s} ${y} L${x - 3.6 * s} ${y + 4}`} fill="none" stroke={C.eye} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />;
  }
  if (kind === 'heart') {
    return <path d={heartPath(x, y, 5)} fill="#E8435A" />;
  }
  const ry = kind === 'focused' ? 4.6 : kind === 'wide' ? 6.8 : 6.1;
  const rx = kind === 'wide' ? 4.9 : 4.5;
  return (
    <g className="cpm-eye" style={{ '--ex': `${x}px` } as CSSProperties}>
      <ellipse cx={x} cy={y} rx={rx} ry={ry} fill={C.eye} />
    </g>
  );
}

/** The magnifier lives inside the right arm's group, drawn as if the arm hung
 *  at rest, so it swings with the arm instead of being animated to match it. */
function Magnifier() {
  return (
    <g>
      <path d="M85.5 95 L87 102.5" stroke="#7A4A2C" strokeWidth={4} strokeLinecap="round" />
      <circle cx={88.5} cy={110.5} r={8.2} fill="#DDF0FF" fillOpacity={0.6} stroke="#5A3A2A" strokeWidth={3.2} />
      <path d="M84 107 C85 105 87 104 89.5 104" stroke="#fff" strokeWidth={1.8} fill="none" strokeLinecap="round" />
    </g>
  );
}

/** The whole lying-at-the-laptop scene, back to front, from the traced layers
 *  in lyingPose.ts. Main orange for head and body, the lighter orange the art
 *  uses for horns, tail and paws, and the crease tone for the shadows. */
function LieScene({ eyes, blink, wag }: { eyes: Eyes; blink: boolean; wag: boolean }) {
  const eye = (d: string, [x, y]: readonly [number, number]) => (
    <g className="cpm-eye" style={{ transformOrigin: `${x}px ${y}px`, transform: eyes === 'focused' ? 'scaleY(0.72)' : undefined }}>
      <path d={d} fill={C.eye} />
    </g>
  );
  const layer = (d: string, fill: string) => <path d={d} fill={fill} fillRule="evenodd" />;
  return (
    <g>
      {layer(L.LIE_SIL, C.orange)}
      {layer(L.LIE_LIGHT, C.light)}
      {layer(L.LIE_CREASE, C.crease)}
      <g className={wag ? 'cpm-tail cpm-tail--lie' : undefined}>
        {layer(L.LIE_TAIL, C.orange)}
        {layer(L.LIE_TAIL_LIGHT, C.light)}
        {layer(L.LIE_TAIL_CREASE, C.crease)}
      </g>
      {layer(L.LIE_FACE, C.cream)}
      <g className={blink ? 'cpm-eyes--blink' : undefined}>
        {eye(L.LIE_EYE_L, L.LIE_EYE_L_AT)}
        {eye(L.LIE_EYE_R, L.LIE_EYE_R_AT)}
      </g>
      {layer(L.LIE_BASE, C.lidDark)}
      <g className="cpm-paw cpm-paw--r">
        {layer(L.LIE_PAW_R, C.orange)}
        {layer(L.LIE_PAW_R_LIGHT, C.light)}
      </g>
      <g className="cpm-paw cpm-paw--l">
        {layer(L.LIE_PAW_L, C.orange)}
        {layer(L.LIE_PAW_L_LIGHT, C.light)}
        {layer(L.LIE_PAW_L_CREASE, C.crease)}
      </g>
      {layer(L.LIE_LID, C.lid)}
      {layer(L.LIE_LOGO, C.cream)}
    </g>
  );
}

function Hands({ y = 100 }: { y?: number }) {
  return (
    <g>
      <Limb cx={48} cy={y} rx={4.6} ry={4} rot={0} dx={0.9} />
      <Limb cx={80} cy={y} rx={4.6} ry={4} rot={0} dx={-0.9} />
    </g>
  );
}

function FrontProp({ kind }: { kind: Prop }) {
  switch (kind) {
    case 'book':
      return (
        <g>
          <path d="M43 91 C54 87 60 88 64 90.5 C68 88 74 87 85 91 L85 107 C74 103 68 104 64 106.5 C60 104 54 103 43 107 Z" fill="#4F79D8" />
          <path d="M45 90 C55 86.6 60 87.6 64 90 L64 105 C60 102.8 55 102 45 105 Z" fill="#fff" />
          <path d="M83 90 C73 86.6 68 87.6 64 90 L64 105 C68 102.8 73 102 83 105 Z" fill="#F4EEE6" />
          <g stroke="#D7CEC4" strokeWidth={1} strokeLinecap="round" fill="none">
            <path d="M49 94 C53 92.6 57 92.6 60 93.6" /><path d="M49 98 C53 96.6 57 96.6 60 97.6" />
            <path d="M68 93.6 C71 92.6 75 92.6 79 94" /><path d="M68 97.6 C71 96.6 75 96.6 79 98" />
          </g>
          <Hands y={99} />
        </g>
      );
    case 'notepad':
      return (
        <g>
          <path d="M47 89 L77 89 C78.5 89 79 89.8 79 91 L79 107 C79 108.2 78.5 109 77 109 L47 109 C45.5 109 45 108.2 45 107 L45 91 C45 89.8 45.5 89 47 89 Z" fill="#fff" stroke="#E4D6C8" />
          <g stroke="#CFC2B4" strokeWidth={1} strokeLinecap="round">
            <path d="M49 94 L74 94" /><path d="M49 98.5 L74 98.5" /><path d="M49 103 L64 103" />
          </g>
          <g className="cpm-pencil">
            <path d="M71 100 L81 86" stroke="#F4B63F" strokeWidth={3.6} strokeLinecap="round" />
            <path d="M81 86 L82.8 83.6" stroke="#F08BA0" strokeWidth={3.6} strokeLinecap="round" />
            <path d="M71 100 L69.8 101.8" stroke="#5A3A2A" strokeWidth={1.8} strokeLinecap="round" />
          </g>
          <Hands y={101} />
        </g>
      );
    case 'gamepad':
      return (
        <g>
          <path d="M45 95 C46.5 90.5 52 90 55 90 L73 90 C76 90 81.5 90.5 83 95 L85.6 104 C86.4 108 83.6 109.4 81.6 109.4 C79 109.4 77.6 107.6 76 105.6 L52 105.6 C50.4 107.6 49 109.4 46.4 109.4 C44.4 109.4 41.6 108 42.4 104 Z" fill="#3B3F4A" />
          <path d="M52.5 95.5 L52.5 101.5 M49.5 98.5 L55.5 98.5" stroke="#9AA3B2" strokeWidth={2.2} strokeLinecap="round" />
          <circle cx={74.5} cy={96.5} r={1.9} fill="#F26B6B" />
          <circle cx={78.5} cy={100.2} r={1.9} fill="#6BC6F2" />
          <Hands y={100} />
        </g>
      );
    default:
      return null;
  }
}

function HeadProp({ kind }: { kind: Prop }) {
  if (kind === 'headset') {
    return (
      <g>
        <path d="M32 50 C31 30 44 21 64 21 C84 21 97 30 96 50" fill="none" stroke={C.metal} strokeWidth={3.6} strokeLinecap="round" />
        <path d="M27 42 C29.5 42 31.5 44 31.5 46.5 L31.5 55.5 C31.5 58 29.5 60 27 60 C24.5 60 23 58 23 55.5 L23 46.5 C23 44 24.5 42 27 42 Z" fill={C.metal} />
        <path d="M101 42 C103.5 42 105 44 105 46.5 L105 55.5 C105 58 103.5 60 101 60 C98.5 60 96.5 58 96.5 55.5 L96.5 46.5 C96.5 44 98.5 42 101 42 Z" fill={C.metal} />
        <path d="M27 60 C28 67 34 70 43 69" fill="none" stroke={C.metal} strokeWidth={2} strokeLinecap="round" />
        <circle cx={44.5} cy={69} r={2.5} fill="#2E3238" />
      </g>
    );
  }
  if (kind === 'sunglasses') {
    return (
      <g>
        <path d="M44 45 L60.5 45 C61.6 45 62 45.6 62 46.6 L62 51 C62 55 59 57.5 55 57.5 L50 57.5 C46 57.5 43 55 43 51 L43 46 C43 45.4 43.4 45 44 45 Z" fill="#1C1C22" />
        <path d="M84 45 L67.5 45 C66.4 45 66 45.6 66 46.6 L66 51 C66 55 69 57.5 73 57.5 L78 57.5 C82 57.5 85 55 85 51 L85 46 C85 45.4 84.6 45 84 45 Z" fill="#1C1C22" />
        <path d="M61 47 L67 47" stroke="#1C1C22" strokeWidth={2.4} />
        <path d="M46.5 48.5 L51 47.2 M69.5 48.5 L74 47.2" stroke="#fff" strokeOpacity={0.55} strokeWidth={1.5} strokeLinecap="round" />
      </g>
    );
  }
  return null;
}

function Effect({ kind }: { kind: Fx }) {
  const font = "'Geist Variable', Geist, system-ui, sans-serif";
  switch (kind) {
    case 'zzz':
      return (
        <g fill="#8FA3D9" fontFamily={font} fontWeight={800}>
          <text className="cpm-float" x={98} y={40} fontSize={10}>z</text>
          <text className="cpm-float" x={106} y={29} fontSize={13}>z</text>
          <text className="cpm-float" x={114} y={17} fontSize={16}>z</text>
        </g>
      );
    case 'question':
      return <text className="cpm-bob-fx" x={106} y={34} fontSize={22} fontWeight={800} fill={C.orange} fontFamily={font}>?</text>;
    case 'exclaim':
      return <text className="cpm-pop" style={origin(111, 24)} x={107} y={34} fontSize={24} fontWeight={900} fill={C.orange} fontFamily={font}>!</text>;
    case 'thought':
      return (
        <g fill="#fff" stroke="#E2D5CA" strokeWidth={1.2}>
          <circle className="cpm-pop" style={{ ...origin(104, 36), animationDelay: '0s' }} cx={104} cy={36} r={2.2} />
          <circle className="cpm-pop" style={{ ...origin(110, 27), animationDelay: '0.25s' }} cx={110} cy={27} r={3.2} />
          <circle className="cpm-pop" style={{ ...origin(117, 15), animationDelay: '0.5s' }} cx={117} cy={15} r={5} />
        </g>
      );
    case 'check':
      return (
        <g className="cpm-pop" style={origin(112, 34)}>
          <circle cx={112} cy={34} r={8} fill="#2FA86B" />
          <path d="M108 34 L111 37 L116.2 31.2" fill="none" stroke="#fff" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
        </g>
      );
    case 'lock':
      return (
        <g className="cpm-bob-fx">
          <path d="M108 33 L108 29.5 C108 26.8 110 25 112.5 25 C115 25 117 26.8 117 29.5 L117 33" fill="none" stroke="#8A94A3" strokeWidth={2.2} />
          <path d="M106.5 32.5 L118.5 32.5 C119.6 32.5 120 33.1 120 34.2 L120 42 C120 43.1 119.6 43.6 118.5 43.6 L106.5 43.6 C105.4 43.6 105 43.1 105 42 L105 34.2 C105 33.1 105.4 32.5 106.5 32.5 Z" fill="#E8A826" />
          <circle cx={112.5} cy={37.2} r={1.6} fill="#7A5410" />
        </g>
      );
    case 'hourglass':
      return (
        <g className="cpm-flip" style={origin(112, 34)}>
          <path d="M107.5 25 L116.5 25 L112 34 L116.5 43 L107.5 43 L112 34 Z" fill="#DCEFFF" stroke="#8A6A4F" strokeWidth={1.4} strokeLinejoin="round" />
          <path d="M109.5 27 L114.5 27 L112 31.5 Z" fill="#F2B54A" />
          <path d="M109.8 41.5 L114.2 41.5 L112 38 Z" fill="#F2B54A" />
          <path d="M105.5 24.5 L118.5 24.5 M105.5 43.5 L118.5 43.5" stroke="#8A6A4F" strokeWidth={2.2} strokeLinecap="round" />
        </g>
      );
    case 'gear':
      return (
        <g className="cpm-spin" style={origin(112, 34)}>
          <circle cx={112} cy={34} r={7.6} fill="none" stroke="#8C96A3" strokeWidth={3.8} strokeDasharray="2.98 2.98" />
          <circle cx={112} cy={34} r={6.2} fill="#AEB6C0" />
          <circle cx={112} cy={34} r={2.2} fill="#fff" />
        </g>
      );
    case 'blocks':
      return (
        <g className="cpm-stack">
          <rect x={104} y={38} width={8} height={8} rx={2} fill={C.orange} />
          <rect x={113} y={38} width={8} height={8} rx={2} fill="#F2B54A" />
          <rect x={108.5} y={29} width={8} height={8} rx={2} fill="#5E8BE0" />
        </g>
      );
    case 'calendar':
      return (
        <g className="cpm-bob-fx">
          <rect x={103} y={26} width={18} height={17} rx={3} fill="#fff" stroke="#E0CFC0" />
          <path d="M103 31.5 L103 29 C103 27.3 104.3 26 106 26 L118 26 C119.7 26 121 27.3 121 29 L121 31.5 Z" fill="#E8553A" />
          <path d="M107.5 24 L107.5 28 M116.5 24 L116.5 28" stroke="#8A6A4F" strokeWidth={1.8} strokeLinecap="round" />
          <circle cx={108} cy={35.5} r={1.3} fill="#CDBFB2" />
          <circle cx={112} cy={35.5} r={1.3} fill="#CDBFB2" />
          <circle cx={116.5} cy={35.5} r={1.8} fill={C.orange} />
          <circle cx={108} cy={39.5} r={1.3} fill="#CDBFB2" />
          <circle cx={112} cy={39.5} r={1.3} fill="#CDBFB2" />
        </g>
      );
    case 'database':
      return (
        <g>
          <path d="M104 33 L104 43 C104 45 120 45 120 43 L120 33 Z" fill="#5E8BE0" />
          <ellipse cx={112} cy={33} rx={8} ry={2.8} fill="#9BB4F0" />
          <g className="cpm-drop-in">
            <rect x={108.5} y={17} width={7} height={9} rx={1.5} fill="#fff" stroke="#E0CFC0" />
            <path d="M110.5 20 L113.5 20 M110.5 22.5 L113.5 22.5" stroke="#CDBFB2" strokeWidth={1} />
          </g>
        </g>
      );
    case 'talkwaves':
      return (
        <g fill="none" stroke={C.orange} strokeWidth={2.3} strokeLinecap="round">
          <path className="cpm-wave-arc" d="M103 44 C106 48 106 53 103 57" />
          <path className="cpm-wave-arc" d="M108 40 C112.5 46 112.5 55 108 61" />
          <path className="cpm-wave-arc" d="M113 36 C119 44 119 57 113 65" />
        </g>
      );
    case 'listenwaves':
      return (
        <g fill="none" stroke="#5E8BE0" strokeWidth={2.2} strokeLinecap="round">
          <path className="cpm-wave-arc" d="M19 45 C16 49 16 54 19 58" />
          <path className="cpm-wave-arc" d="M14 41 C9.5 47 9.5 56 14 62" />
          <path className="cpm-wave-arc" d="M9 37 C3 45 3 58 9 66" />
        </g>
      );
    case 'sweat':
      return <path className="cpm-drip" d="M99.5 30 C101.8 33 104 35.6 104 37.6 C104 40 101.8 41.4 99.5 41.4 C97.2 41.4 95 40 95 37.6 C95 35.6 97.2 33 99.5 30 Z" fill="#8FD0FF" />;
    case 'hearts':
      return (
        <g fill="#F0506E">
          <path className="cpm-float" d={heartPath(104, 36, 3.8)} />
          <path className="cpm-float" d={heartPath(113, 25, 4.6)} />
          <path className="cpm-float" d={heartPath(101, 18, 3.4)} />
        </g>
      );
    case 'sparkles':
      return (
        <g fill="#FFC53D">
          <path className="cpm-twinkle" style={origin(16, 24)} d={sparklePath(16, 24, 5.5)} />
          <path className="cpm-twinkle" style={origin(114, 20)} d={sparklePath(114, 20, 6.5)} />
          <path className="cpm-twinkle" style={origin(116, 66)} d={sparklePath(116, 66, 4.6)} />
          <path className="cpm-twinkle" style={origin(11, 70)} d={sparklePath(11, 70, 4.2)} />
        </g>
      );
    case 'confetti': {
      const bits: [number, number, string, number][] = [
        [14, 16, C.orange, 0], [30, 6, '#5E8BE0', 0.4], [50, 2, '#FFC53D', 0.9], [78, 0, '#2FA86B', 0.2],
        [96, 4, '#F0506E', 0.7], [112, 12, '#5E8BE0', 1.1], [20, 30, '#FFC53D', 1.3], [108, 26, C.orange, 0.5],
      ];
      return (
        <g>
          {bits.map(([x, y, fill, delay], i) => (
            <rect key={i} className="cpm-confetti" style={{ animationDelay: `${delay}s` }}
              x={x} y={y} width={3.6} height={6} rx={1} fill={fill} />
          ))}
        </g>
      );
    }
    case 'mini':
      return (
        <g>
          {([[112, 38, 1, '0s'], [15, 44, 0.8, '1s']] as const).map(([x, y, s, delay]) => (
            <g key={x} className="cpm-pop" style={{ ...origin(x, y + 6 * s), animationDelay: delay }}>
              <path d={`M${x - 5 * s} ${y - 5 * s} C${x - 6.5 * s} ${y - 8 * s} ${x - 6.5 * s} ${y - 11 * s} ${x - 5 * s} ${y - 12 * s} C${x - 3.5 * s} ${y - 10 * s} ${x - 2 * s} ${y - 8 * s} ${x - 1 * s} ${y - 6.5 * s} Z`} fill={C.orange} />
              <path d={`M${x + 5 * s} ${y - 5 * s} C${x + 6.5 * s} ${y - 8 * s} ${x + 6.5 * s} ${y - 11 * s} ${x + 5 * s} ${y - 12 * s} C${x + 3.5 * s} ${y - 10 * s} ${x + 2 * s} ${y - 8 * s} ${x + 1 * s} ${y - 6.5 * s} Z`} fill={C.orange} />
              <ellipse cx={x} cy={y} rx={9 * s} ry={7.4 * s} fill={C.orange} />
              <ellipse cx={x} cy={y + 0.4 * s} rx={6.8 * s} ry={3.8 * s} fill={C.cream} />
              <ellipse cx={x - 2.8 * s} cy={y + 0.4 * s} rx={1 * s} ry={1.5 * s} fill={C.eye} />
              <ellipse cx={x + 2.8 * s} cy={y + 0.4 * s} rx={1 * s} ry={1.5 * s} fill={C.eye} />
            </g>
          ))}
        </g>
      );
    case 'lines':
      return (
        <g fill="none" stroke={C.orange} strokeWidth={2.6} strokeLinecap="round">
          <path className="cpm-wave-arc" d="M21 40 L26 44.5" />
          <path className="cpm-wave-arc" d="M18.5 50.5 L25 51" />
          <path className="cpm-wave-arc" d="M21 60 L26 57" />
          <path className="cpm-wave-arc" d="M107 40 L102 44.5" />
          <path className="cpm-wave-arc" d="M109.5 50.5 L103 51" />
          <path className="cpm-wave-arc" d="M107 60 L102 57" />
        </g>
      );
  }
}

// ── Body layouts ─────────────────────────────────────────────────────────────

/** Where the head sits for each layout, as an offset from the standing pose. */
const HEAD_AT: Record<Exclude<Layout, 'lie'>, [number, number]> = { stand: [0, 0], sit: [0, 8] };

function Body({ layout, wag }: { layout: Exclude<Layout, 'lie'>; wag: boolean }) {
  if (layout === 'sit') {
    return (
      <g>
        <g className={wag ? 'cpm-tail' : undefined}>
          <path d={TAIL} transform="translate(0 6)" fill={C.light} />
        </g>
        <path d={SIT_BODY} fill={C.orange} />
        <path d={SIT_BELLY} fill={C.cream} />
        <path d={NECK} transform="translate(0 8)" fill={C.crease} />
        {/* Legs out in front, soles to the viewer. */}
        <Limb cx={50.5} cy={104} rx={8.6} ry={6.6} rot={-14} dx={1} dy={-0.6} />
        <Limb cx={77.5} cy={104} rx={8.6} ry={6.6} rot={14} dx={-1} dy={-0.6} />
      </g>
    );
  }
  return (
    <g>
      <g className={wag ? 'cpm-tail' : undefined}>
        <path d={TAIL} fill={C.light} />
        <path d="M44.4 89.2 C43.2 92.2 43.6 95.8 46 98.2" fill="none" stroke={C.crease} strokeWidth={1.5} strokeLinecap="round" />
      </g>
      <path d={BODY} fill={C.orange} />
      <path d={BELLY} fill={C.cream} />
      <path d={NECK} fill={C.crease} />
    </g>
  );
}

// ── The creature ─────────────────────────────────────────────────────────────

export function CinderpawMascot({ state, flip = false, size = BASE_W }: { state: MascotState; flip?: boolean; size?: number }) {
  const pose = POSES[state] ?? POSES.idle;
  const layout = pose.layout ?? 'stand';
  const props = pose.props ?? [];
  const fx = pose.fx ?? [];
  const blink = pose.eyes === 'open' || pose.eyes === 'wide' || pose.eyes === 'focused';
  const look = pose.look ?? 'center';
  const lookOffset: Record<Look, string> = {
    center: 'translate(0px, 0px)', down: 'translate(0px, 2.2px)', up: 'translate(-1.8px, -2.2px)', side: 'translate(2.6px, 0.6px)', scan: '',
  };

  const rootClass = [
    'cpm',
    `cpm--${pose.motion}`,
    `cpm-arms--${pose.arms}`,
    pose.nod ? 'cpm--nod' : '',
    pose.wiggle ? 'cpm--wiggle' : '',
  ].filter(Boolean).join(' ');

  // Each arm is its own group so it can swing from the shoulder; the shapes
  // inside keep their resting slant as attributes, the group moves by CSS.
  const arm = (side: 'l' | 'r', children?: ReactNode) => (
    <g className={`cpm-arm-${side}`}>
      <Limb cx={side === 'l' ? 44.5 : 83.5} cy={87.5} rx={5.4} ry={9} rot={side === 'l' ? 16 : -16} dx={side === 'l' ? 1.1 : -1.1} />
      {children}
    </g>
  );

  return (
    <svg
      aria-hidden="true"
      data-mascot-state={state}
      className={rootClass}
      width={size}
      height={Math.round((size * BASE_H) / BASE_W)}
      viewBox={`0 0 ${BASE_W} ${BASE_H}`}
      style={{ display: 'block', pointerEvents: 'none' }}
    >
      <g transform={flip ? `translate(${BASE_W} 0) scale(-1 1)` : undefined}>
        <ellipse cx={layout === 'lie' ? 60 : 64} cy={111} rx={layout === 'lie' ? 54 : 26} ry={2.8} fill="#000" opacity={0.08} />

        {layout === 'lie' ? (
          <g className="cpm-creature">
            <LieScene eyes={pose.eyes} blink={blink} wag={!!pose.wag} />
          </g>
        ) : (
        <g className="cpm-creature">
          <Body layout={layout} wag={!!pose.wag} />

          <g transform={`translate(${HEAD_AT[layout][0]} ${HEAD_AT[layout][1]}) rotate(${pose.tilt ?? 0} 64 74)`}>
            <g className="cpm-head">
              <g className="cpm-horns">
                <path d={HORN_L} fill={C.light} />
                <path d={HORN_R} fill={C.light} />
              </g>
              <path d={HEAD} fill={C.orange} />
              <path d={FACE} fill={C.cream} />
              <g
                className={`cpm-look ${look === 'scan' ? 'cpm-look--scan' : ''} ${blink ? 'cpm-eyes--blink' : ''}`}
                style={look === 'scan' ? undefined : { transform: lookOffset[look] }}
              >
                <Eye x={50.8} kind={pose.eyes} />
                <Eye x={77.2} kind={pose.eyes} />
              </g>
              {props.map((p) => <HeadProp key={p} kind={p} />)}
            </g>
          </g>

          <g transform={layout === 'sit' ? 'translate(0 8)' : undefined}>
            {arm('l')}
            {arm('r', props.includes('magnifier') ? <Magnifier /> : null)}
          </g>

          {props.map((p) => <FrontProp key={p} kind={p} />)}
        </g>
        )}

        {/* Lying, the far horn takes the top-right corner the effects use. */}
        <g transform={layout === 'lie' ? 'translate(4 -10)' : undefined}>
          {fx.map((f) => <Effect key={f} kind={f} />)}
        </g>
      </g>
    </svg>
  );
}
