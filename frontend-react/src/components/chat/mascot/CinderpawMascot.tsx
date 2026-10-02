import { useEffect, useState, type CSSProperties } from 'react';
import type { MascotState } from './frames';
import { SCENES, type Layers, type Part, type Scene, type SceneName } from './scenes';
import './mascot.css';

/**
 * The creature, drawn as vectors.
 *
 * It used to be a 302-frame pixel sheet rendered out of Blender and blitted
 * onto a canvas. Now every pose is one of the seven flat drawings of the
 * character (docs/design/moodboard/SVG/), traced into SVG layers by
 * scripts/mascot/svg/trace_poses.py into scenes.ts: the two oranges, the
 * outline and shadow tones, the cream, the eyes, and the marks drawn beside
 * it. Laid over its drawing, each scene matches it.
 *
 * What moves is cut out of the trace with a margin of body under it, so it can
 * turn without opening a gap: the tail wags, the waving arm waves, the paws tap
 * the keys; the eyes blink, the action lines flicker, the Zzz drift. A state is
 * a scene plus a body motion and, where the drawing has none, a prop or an
 * effect: a line in POSES, not a render.
 *
 * The drawing is 128x132 with the soles at y=110, the same footprint the
 * sprite had, so the perch's placement above the composer still holds.
 */

/** Width at scale 1, and the drawing's own width. Height follows at 132/128. */
const BASE_W = 128;
const BASE_H = 132;

const C = {
  orange: '#F05A24',
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

type Eyes = 'drawn' | 'focused' | 'heart';
type Look = 'center' | 'side' | 'up' | 'scan';
type Motion = 'breathe' | 'bob' | 'bounce' | 'jump' | 'shake' | 'sway' | 'sleep' | 'stretch' | 'jolt';
type Prop = 'book' | 'notepad' | 'gamepad' | 'magnifier' | 'headset' | 'sunglasses';
type Fx =
  | 'question' | 'exclaim' | 'thought' | 'check' | 'confetti' | 'sparkles' | 'hearts'
  | 'sweat' | 'lock' | 'hourglass' | 'gear' | 'blocks' | 'calendar' | 'database' | 'talkwaves'
  | 'listenwaves' | 'mini' | 'lines' | 'zzz';

interface Pose {
  scene: SceneName;
  motion: Motion;
  /** The drawing's own eyes, narrowed to concentrate, or hearts in their place. */
  eyes?: Eyes;
  look?: Look;
  props?: Prop[];
  fx?: Fx[];
  /** The drawing's action lines or Zzz; off where they would say the wrong thing. */
  marks?: boolean;
  wag?: boolean;
}

// Seven drawings: sit (calm, hand to the mouth), think (hand at the chin),
// wave, cheer (both arms up), surprised (hands on the cheeks), laptop (lying at
// the keys) and sleep (lying, eyes shut).
const POSES: Record<MascotState, Pose> = {
  idle:       { scene: 'sit', motion: 'breathe', wag: true },
  typing:     { scene: 'laptop', motion: 'breathe', wag: true },
  thinking:   { scene: 'think', motion: 'sway', look: 'up', fx: ['thought'] },
  calling:    { scene: 'think', motion: 'bob', props: ['headset'], fx: ['talkwaves'] },
  done:       { scene: 'cheer', motion: 'bounce', fx: ['check'], wag: true },
  running:    { scene: 'laptop', motion: 'breathe', eyes: 'focused', fx: ['gear'], wag: true },
  // No marks on the wave scene: its two dashes beside the raised paw read as fingers (2 Oct).
  wave:       { scene: 'wave', motion: 'breathe', wag: true },
  sleep:      { scene: 'sleep', motion: 'sleep', marks: true },
  surprised:  { scene: 'surprised', motion: 'jolt', marks: true },
  curious:    { scene: 'think', motion: 'breathe', look: 'side', wag: true },
  celebrate:  { scene: 'cheer', motion: 'jump', fx: ['confetti'], wag: true },
  reading:    { scene: 'sit', motion: 'breathe', props: ['book'] },
  searching:  { scene: 'think', motion: 'breathe', look: 'scan', props: ['magnifier'] },
  building:   { scene: 'laptop', motion: 'breathe', eyes: 'focused', fx: ['blocks'] },
  writing:    { scene: 'sit', motion: 'breathe', props: ['notepad'] },
  stretching: { scene: 'cheer', motion: 'stretch' },
  gaming:     { scene: 'sit', motion: 'bob', eyes: 'focused', props: ['gamepad'] },
  love:       { scene: 'surprised', motion: 'bounce', eyes: 'heart', fx: ['hearts'], wag: true },
  cool:       { scene: 'wave', motion: 'sway', props: ['sunglasses'], wag: true },
  error:      { scene: 'surprised', motion: 'shake', fx: ['sweat'] },
  excited:    { scene: 'cheer', motion: 'jump', fx: ['sparkles'], wag: true },
  spawning:   { scene: 'cheer', motion: 'bounce', fx: ['mini'] },
  asking:     { scene: 'think', motion: 'breathe', fx: ['question'], wag: true },
  waiting:    { scene: 'think', motion: 'breathe', look: 'up', fx: ['hourglass'], wag: true },
  speaking:   { scene: 'wave', motion: 'bob', fx: ['talkwaves'] },
  listening:  { scene: 'sit', motion: 'breathe', props: ['headset'], fx: ['listenwaves'] },
  blocked:    { scene: 'think', motion: 'breathe', fx: ['lock'] },
  scheduling: { scene: 'think', motion: 'breathe', look: 'up', fx: ['calendar'] },
  storing:    { scene: 'cheer', motion: 'breathe', fx: ['database'] },
};

// ── Helpers (absolute coordinates: an animated group must never carry a
//    transform attribute, or its CSS transform replaces it) ────────────────────

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

/** One traced part in its four tones. */
function Tones({ layers, colors }: { layers: Layers; colors: Scene['colors'] }) {
  const L = (d: string, fill: string) => (d ? <path d={d} fill={fill} fillRule="evenodd" /> : null);
  return (
    <>
      {L(layers.sil, colors.main)}
      {L(layers.light, colors.light)}
      {L(layers.outline, colors.outline)}
      {L(layers.shadow, colors.shadow)}
    </>
  );
}

/** A part that moves: its own group, turning about its pivot. */
function Moving({ part, colors, className }: { part?: Part; colors: Scene['colors']; className?: string }) {
  if (!part) return null;
  return (
    <g className={className} style={origin(part.pivot[0], part.pivot[1])}>
      <Tones layers={part} colors={colors} />
    </g>
  );
}

// ── Props, placed on each drawing ────────────────────────────────────────────

/** Where the hands are in the two drawings that hold things. */
const HANDS: Partial<Record<SceneName, readonly [number, number]>> = {
  sit: [62, 76],
  think: [80, 73],
};

function Magnifier({ at: [x, y] }: { at: readonly [number, number] }) {
  // Held up by the hand at the chin, the lens beside the face.
  return (
    <g>
      <path d={`M${x + 1} ${y - 2} L${x + 9} ${y - 10}`} stroke="#7A4A2C" strokeWidth={3.6} strokeLinecap="round" />
      <circle cx={x + 15} cy={y - 16} r={8} fill="#DDF0FF" fillOpacity={0.6} stroke="#5A3A2A" strokeWidth={3} />
      <path d={`M${x + 10.5} ${y - 19} C${x + 11.5} ${y - 21} ${x + 13.5} ${y - 22} ${x + 16} ${y - 22}`} stroke="#fff" strokeWidth={1.6} fill="none" strokeLinecap="round" />
    </g>
  );
}

function HeldProp({ kind, at: [x, y] }: { kind: Prop; at: readonly [number, number] }) {
  // Drawn around (0,0) and moved to the hands; the wrapper is not animated.
  const shape = (() => {
    switch (kind) {
      case 'book':
        return (
          <g>
            <path d="M-19 -6 C-8 -10 -3 -9 0 -6.5 C3 -9 8 -10 19 -6 L19 10 C8 6 3 7 0 9.5 C-3 7 -8 6 -19 10 Z" fill="#4F79D8" />
            <path d="M-17 -7 C-7 -10.4 -3 -9.4 0 -7 L0 8 C-3 5.8 -7 5 -17 8 Z" fill="#fff" />
            <path d="M17 -7 C7 -10.4 3 -9.4 0 -7 L0 8 C3 5.8 7 5 17 8 Z" fill="#F4EEE6" />
            <g stroke="#D7CEC4" strokeWidth={1} strokeLinecap="round" fill="none">
              <path d="M-13 -3 C-9 -4.4 -5 -4.4 -2 -3.4" /><path d="M-13 1 C-9 -0.4 -5 -0.4 -2 0.6" />
              <path d="M2 -3.4 C5 -4.4 9 -4.4 13 -3" /><path d="M2 0.6 C5 -0.4 9 -0.4 13 1" />
            </g>
          </g>
        );
      case 'notepad':
        return (
          <g>
            <path d="M-15 -9 L15 -9 C16.5 -9 17 -8.2 17 -7 L17 9 C17 10.2 16.5 11 15 11 L-15 11 C-16.5 11 -17 10.2 -17 9 L-17 -7 C-17 -8.2 -16.5 -9 -15 -9 Z" fill="#fff" stroke="#E4D6C8" />
            <g stroke="#CFC2B4" strokeWidth={1} strokeLinecap="round">
              <path d="M-13 -4 L12 -4" /><path d="M-13 0.5 L12 0.5" /><path d="M-13 5 L2 5" />
            </g>
            <g className="cpm-pencil">
              <path d="M9 2 L19 -12" stroke="#F4B63F" strokeWidth={3.6} strokeLinecap="round" />
              <path d="M19 -12 L20.8 -14.4" stroke="#F08BA0" strokeWidth={3.6} strokeLinecap="round" />
              <path d="M9 2 L7.8 3.8" stroke="#5A3A2A" strokeWidth={1.8} strokeLinecap="round" />
            </g>
          </g>
        );
      case 'gamepad':
        return (
          <g>
            <path d="M-19 -3 C-17.5 -7.5 -12 -8 -9 -8 L9 -8 C12 -8 17.5 -7.5 19 -3 L21.6 6 C22.4 10 19.6 11.4 17.6 11.4 C15 11.4 13.6 9.6 12 7.6 L-12 7.6 C-13.6 9.6 -15 11.4 -17.6 11.4 C-19.6 11.4 -22.4 10 -21.6 6 Z" fill="#3B3F4A" />
            <path d="M-11.5 -2.5 L-11.5 3.5 M-14.5 0.5 L-8.5 0.5" stroke="#9AA3B2" strokeWidth={2.2} strokeLinecap="round" />
            <circle cx={10.5} cy={-1.5} r={1.9} fill="#F26B6B" />
            <circle cx={14.5} cy={2.2} r={1.9} fill="#6BC6F2" />
          </g>
        );
      default:
        return null;
    }
  })();
  return <g transform={`translate(${x} ${y + 3})`}>{shape}</g>;
}

/** What sits on the head, placed by the drawing's eyes: centred on them and
 *  turned with the line between them, so it follows a tilted head. */
function HeadProp({ kind, scene }: { kind: Prop; scene: Scene }) {
  const [l, r] = scene.eyes;
  if (!l || !r) return null;
  const mx = (l.at[0] + r.at[0]) / 2;
  const my = (l.at[1] + r.at[1]) / 2;
  const angle = (Math.atan2(r.at[1] - l.at[1], r.at[0] - l.at[0]) * 180) / Math.PI;
  const half = Math.hypot(r.at[0] - l.at[0], r.at[1] - l.at[1]) / 2;
  const [fx0, fy0, fx1] = scene.faceBox;
  const w = (fx1 - fx0) / 2 + 5;
  const top = my - (my - fy0) - 16;
  const lens = { w: l.rx * 2 + 7, h: l.ry * 2 + 2 };
  return (
    <g transform={`rotate(${angle} ${mx} ${my})`}>
      {kind === 'sunglasses' ? (
        <g fill="#1C1C22">
          {[-half, half].map((dx) => (
            <rect key={dx} x={mx + dx - lens.w / 2} y={my - lens.h / 2} width={lens.w} height={lens.h} rx={lens.h / 2.4} />
          ))}
          <rect x={mx - half + lens.w / 2 - 0.5} y={my - lens.h / 2 + 1.5} width={half * 2 - lens.w + 1} height={2.4} rx={1.2} />
          {[-half, half].map((dx) => (
            <path key={dx} d={`M${mx + dx - lens.w / 2 + 3} ${my - lens.h / 2 + 3.5} L${mx + dx - 1} ${my - lens.h / 2 + 2}`} stroke="#fff" strokeOpacity={0.5} strokeWidth={1.5} strokeLinecap="round" />
          ))}
        </g>
      ) : (
        <g>
          <path d={`M${mx - w} ${my} C${mx - w} ${top} ${mx + w} ${top} ${mx + w} ${my}`} fill="none" stroke={C.metal} strokeWidth={3.4} strokeLinecap="round" />
          <rect x={mx - w - 5} y={my - 8} width={9} height={17} rx={4.2} fill={C.metal} />
          <rect x={mx + w - 4} y={my - 8} width={9} height={17} rx={4.2} fill={C.metal} />
          <path d={`M${mx - w - 1} ${my + 8} C${mx - w} ${my + 16} ${mx - w + 6} ${my + 19} ${mx - w + 14} ${my + 18}`} fill="none" stroke={C.metal} strokeWidth={2} strokeLinecap="round" />
          <circle cx={mx - w + 15.5} cy={my + 18} r={2.4} fill="#2E3238" />
        </g>
      )}
    </g>
  );
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

// ── The creature ─────────────────────────────────────────────────────────────

/** Where the effects' top-right corner lands on each drawing: beside the head,
 *  clear of the far horn. The effects are drawn around (112, 34). */
function fxShift(name: SceneName, scene: Scene): [number, number] {
  if (name === 'laptop') return [4, -10];
  const [, fy0, fx1] = scene.faceBox;
  return [Math.min(122, fx1 + 18) - 112, fy0 + 2 - 34];
}

const LOOK: Record<Exclude<Look, 'scan'>, string> = {
  center: 'translate(0px, 0px)', side: 'translate(1.8px, 0.4px)', up: 'translate(-1.2px, -1.8px)',
};

/** `width` is the rendered width in px; the height follows at 132/128. Not
 *  `size`: that name is kept for icons, which come in four fixed sizes. */
export function CinderpawMascot({ state, flip = false, width = BASE_W }: { state: MascotState; flip?: boolean; width?: number }) {
  const pose = POSES[state] ?? POSES.idle;
  const scene = SCENES[pose.scene];
  const colors = scene.colors;
  const eyes = pose.eyes ?? 'drawn';
  const look = pose.look ?? 'center';
  // Only open, oval eyes blink; the cheer's and the sleeper's are drawn shut.
  const blink = eyes !== 'heart' && pose.scene !== 'cheer' && pose.scene !== 'sleep';
  const hands = HANDS[pose.scene];
  const [sx, sy] = fxShift(pose.scene, scene);
  const drift = pose.scene === 'sleep';

  return (
    <svg
      aria-hidden="true"
      data-mascot-state={state}
      className={`cpm cpm--${pose.motion}`}
      width={width}
      height={Math.round((width * BASE_H) / BASE_W)}
      viewBox={`0 0 ${BASE_W} ${BASE_H}`}
      style={{ display: 'block', pointerEvents: 'none' }}
    >
      <g transform={flip ? `translate(${BASE_W} 0) scale(-1 1)` : undefined}>
        <ellipse cx={64} cy={111} rx={pose.scene === 'laptop' || drift ? 50 : 26} ry={2.6} fill="#000" opacity={0.07} />

        <g className="cpm-creature">
          <Tones layers={scene.base} colors={colors} />
          <Moving part={scene.parts.tail} colors={colors} className={pose.wag ? 'cpm-wag' : undefined} />
          <Moving part={scene.parts.arm} colors={colors} className="cpm-wave-arm" />
          <path d={scene.face} fill={colors.cream} fillRule="evenodd" />
          {/* The traced face has a hole where each eye is drawn. The eye on top
              moves (blink, glance, squint), and whatever it uncovers showed the
              orange body through the hole. A cream patch under each eye, held
              still, keeps the face cream in every frame. */}
          {scene.eyes.map((e, i) => (
            <ellipse key={i} cx={e.at[0]} cy={e.at[1]} rx={e.rx + 2} ry={e.ry + 2} fill={colors.cream} />
          ))}

          <g
            className={look === 'scan' ? 'cpm-look cpm-look--scan' : 'cpm-look'}
            style={look === 'scan' ? undefined : { transform: LOOK[look] }}
          >
            {eyes === 'heart'
              ? scene.eyes.map((e, i) => <path key={i} d={heartPath(e.at[0], e.at[1], Math.max(e.rx, e.ry) * 0.9)} fill="#E8435A" />)
              : scene.eyes.map((e, i) => {
                const at = { transformOrigin: `${e.at[0]}px ${e.at[1]}px` };
                // The squint and the blink are two groups: an animation would
                // replace a transform set on the same element.
                return (
                  <g key={i} style={{ ...at, transform: eyes === 'focused' ? 'scaleY(0.72)' : undefined }}>
                    <g className={blink ? 'cpm-blink' : undefined} style={at}>
                      <path d={e.d} fill={colors.eye} />
                    </g>
                  </g>
                );
              })}
          </g>

          {scene.laptop && <path d={scene.laptop.base} fill={C.lidDark} />}
          <Moving part={scene.parts.pawR} colors={colors} className="cpm-tap" />
          <Moving part={scene.parts.pawL} colors={colors} className="cpm-tap cpm-tap--late" />
          {scene.laptop && (
            <>
              <path d={scene.laptop.lid} fill={C.lid} />
              <path d={scene.laptop.logo} fill={colors.cream} />
            </>
          )}

          {(pose.props ?? []).map((p) =>
            p === 'headset' || p === 'sunglasses' ? <HeadProp key={p} kind={p} scene={scene} />
              : p === 'magnifier' ? (hands ? <Magnifier key={p} at={hands} /> : null)
                : hands ? <HeldProp key={p} kind={p} at={hands} /> : null,
          )}
        </g>

        {pose.marks && scene.marks.map((m, i) => (
          <path key={i} d={m.d} fill={m.color} className={drift ? 'cpm-float' : 'cpm-wave-arc'} style={{ animationDelay: `${i * 0.3}s` }} />
        ))}

        <g transform={`translate(${sx} ${sy})`}>
          {(pose.fx ?? []).map((f) => <Effect key={f} kind={f} />)}
        </g>
      </g>
    </svg>
  );
}
