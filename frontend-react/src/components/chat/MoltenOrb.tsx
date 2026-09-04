/**
 * The call sphere, as a fragment shader.
 *
 * This replaces a stack of blurred CSS radial gradients, and the reason is not
 * polish — it is that the effect was not reachable in that medium. Molten metal
 * is made by DOMAIN WARPING: you sample noise, use the result to displace the
 * coordinates of a second noise sample, and displace again with that. Each pass
 * folds the field over itself, which is what produces the long stretched veins
 * that pool and tear. A radial gradient has no coordinates to displace; layering
 * more of them averages toward an even wash, so every attempt landed on the same
 * soft mottled bead. Three passes of warped fbm gets there in about forty lines
 * of GLSL.
 *
 * No three.js, and no geometry at all. An orthographic sphere needs neither: the
 * surface normal at any pixel is `vec3(uv, sqrt(1 - |uv|²))`, so one full-quad
 * fragment shader gives a correctly shaded ball. Adding a scene graph and a mesh
 * to draw a single sphere would be ~600 KB of dependency to compute a square
 * root.
 *
 * What drives it is measured, not invented: `levelRef` carries the same smoothed
 * loudness the rest of the overlay uses — the microphone while the user talks,
 * the reply's own audio while the agent does.
 *
 * Falls back by REPORTING failure rather than by drawing nothing. If WebGL2 is
 * missing or the context is lost and cannot be restored, `onUnavailable` fires
 * and the caller puts the CSS sphere back. A machine with a blocklisted GPU must
 * get a working call screen, not a hole where the sphere was.
 */

import { useEffect, useRef, type RefObject } from 'react';

import { tauri } from '@/lib/tauri';

/**
 * Report to the TERMINAL, not to the WebView console.
 *
 * A shader that fails to compile falls back to the CSS sphere, which still
 * looks like a sphere — so the failure is silent by construction, and the only
 * symptom is "it doesn't look like the mockup on my machine". That is a
 * question nobody can answer without this line. Fire-and-forget: diagnostics
 * must never be what breaks a call.
 */
const report = (message: string) => {
  void tauri.raw.uiLog('orb', message).catch(() => {});
};

export interface MoltenPalette {
  /** `r, g, b` in 0-255, matching the CSS palette so both paths agree. */
  deep: string;
  mid: string;
  hot: string;
}

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `#version 300 es
precision highp float;
out vec4 outColor;

uniform vec2  uSize;
uniform float uTime;
/* Smoothed voice loudness, 0..1. Measured; never synthesised. */
uniform float uLevel;
/* Per-phase flow multiplier — calmer at rest than mid-answer. */
uniform float uFlow;
uniform vec3  uDeep;
uniform vec3  uMid;
uniform vec3  uHot;

/* Hash-based value noise. Cheaper than simplex and, once folded three times by
   the warp below, indistinguishable in the result. */
float hash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float noise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
                 mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                 mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}

/* Three octaves, not five. Five gave a cooled lava crust — correct physics for
   rock, wrong object. The mockup is poured metal: large smooth forms, almost no
   high-frequency detail. Judged side by side in a browser, not guessed. */
float fbm(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 3; i++) {
    sum += amp * noise(p);
    p *= 2.03;
    amp *= 0.5;
  }
  return sum;
}

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

void main() {
  vec2 uv = (gl_FragCoord.xy / uSize) * 2.0 - 1.0;
  uv.y = -uv.y;
  float r2 = dot(uv, uv);
  if (r2 > 1.0) discard;

  /* The sphere, without a sphere: z from the unit-circle equation gives the
     surface normal directly, and the whole ball is shaded from it. */
  float z = sqrt(max(0.0, 1.0 - r2));
  vec3 N = vec3(uv, z);

  float t = uTime * uFlow;

  vec3 p = N * 1.0;
  /* Squash one axis before sampling. Isotropic noise gives turbulent cloud; a
     compressed axis stretches every feature into a band, which is what marble
     and poured metal look like. Squashing in a ROTATED frame is what keeps the
     bands off vertical — the first version with an unrotated squash produced a
     ball that looked combed. */
  vec2 e = rot(0.60) * p.xy;
  e.y *= 0.30;
  p.xy = rot(-0.60) * e;
  p.xz = rot(t * 0.10) * p.xz;

  /* Warp one: a vector field of noise. */
  vec3 q = vec3(
    fbm(p + vec3(0.00, 0.00, t * 0.15)),
    fbm(p + vec3(5.20, 1.30, t * 0.12)),
    fbm(p + vec3(1.70, 9.20, t * 0.10)));

  /* Warp two, displaced by the first. This is the step that turns clouds into
     metal — with only one warp the field stays isotropic and reads as fog. */
  vec3 r = vec3(
    fbm(p + 4.2 * q + vec3(1.70, 9.20, t * 0.20)),
    fbm(p + 4.2 * q + vec3(8.30, 2.80, t * 0.18)),
    fbm(p + 4.2 * q + vec3(2.80, 8.30, t * 0.16)));

  float f = clamp(fbm(p + 4.8 * r), 0.0, 1.0);

  /* Tight ramp stops. Wide ones average the three colours into a single muddy
     mid-tone; the hard shoulders are what read as folds in the melt. A loud
     voice narrows them further, so the sphere visibly sharpens as it speaks. */
  float squeeze = uLevel * 0.05;
  vec3 col = mix(uDeep, uMid, smoothstep(0.16 + squeeze, 0.38 - squeeze, f));
  col = mix(col, uHot, smoothstep(0.42 + squeeze, 0.60 - squeeze, f));

  /* Lit from upper left, and lit hard: a melt is its own light source, so the
     falloff is steeper than a surface catching a lamp. */
  vec3 L = normalize(vec3(-0.45, 0.55, 0.75));
  col *= 0.42 + 0.78 * clamp(dot(N, L), 0.0, 1.0);

  /* Fresnel. Grazing angles at the silhouette carry the hot colour, which is
     what seats the ball against a dark room. */
  col += uHot * pow(1.0 - z, 3.0) * 0.34;

  float sp = clamp(dot(reflect(-L, N), vec3(0.0, 0.0, 1.0)), 0.0, 1.0);
  /* Softer and warmer than a lamp on plastic: a hard white dot read as a
     bead's eye rather than as light on a melt. */
  col += mix(vec3(1.0), uHot / max(uHot.r, 0.001), 0.5) * pow(sp, 22.0) * 0.16;
  /* Broad sheen — the polished, wet look the mockup has and lava does not. */
  col += uHot * pow(sp, 5.0) * 0.38;

  /* The voice brightens the whole body, on top of sharpening the bands. */
  col *= 1.0 + uLevel * 0.30;

  /* Antialias the silhouette in alpha rather than clipping it — a hard circle
     edge on a canvas is visibly stair-stepped next to CSS's rounded corners. */
  float alpha = 1.0 - smoothstep(0.985, 1.0, sqrt(r2));
  outColor = vec4(col, alpha);
}
`;

/** Per-phase flow speed. Matches the intent of the CSS tempos it replaces. */
const FLOW: Record<string, number> = {
  idle: 0.35,
  ready: 0.45,
  listening: 0.85,
  thinking: 1.9,
  speaking: 1.25,
};

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    // Report the CONTEXT state alongside the log. A lost or failed context
    // makes every call return null — including a three-line vertex shader that
    // cannot have a syntax error — and an empty info log then looks like a
    // GLSL problem when it is a graphics-stack problem.
    report(
      `shader failed to compile (${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'}) — ` +
        `lost=${gl.isContextLost()} err=${gl.getError()} ` +
        `ver=${gl.getParameter(gl.VERSION)} glsl=${gl.getParameter(gl.SHADING_LANGUAGE_VERSION)} ` +
        `log=${JSON.stringify(gl.getShaderInfoLog(sh))}`,
    );
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

/** `"226, 88, 22"` → `[0.886, 0.345, 0.086]`. */
function toVec3(rgb: string): [number, number, number] {
  const [r = 0, g = 0, b = 0] = rgb.split(',').map((n) => parseFloat(n.trim()) / 255);
  return [r, g, b];
}

export function MoltenOrb({
  levelRef,
  phase,
  working,
  palette,
  onUnavailable,
}: {
  /** Smoothed 0..1 loudness, written by the overlay's frame loop. */
  levelRef: RefObject<number>;
  phase: string;
  working: boolean;
  palette: MoltenPalette;
  /** Called once if WebGL2 cannot be used, so the caller can fall back. */
  onUnavailable: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Read inside the render loop rather than listed as effect dependencies: the
  // loop must survive a phase change, or the shader's clock restarts and the
  // melt teleports every time the agent starts answering. Same lesson the CSS
  // version learned the hard way with `animation` shorthand restarts.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const workingRef = useRef(working);
  workingRef.current = working;
  const paletteRef = useRef(palette);
  paletteRef.current = palette;
  const failedRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      // The sphere is redrawn every frame; keeping the last one costs memory
      // for nothing.
      preserveDrawingBuffer: false,
      powerPreference: 'low-power',
    });
    if (!gl) {
      report('no WebGL2 on this machine — using the CSS sphere');
      if (!failedRef.current) { failedRef.current = true; onUnavailable(); }
      return;
    }

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    const prog = vs && fs ? gl.createProgram() : null;
    if (!vs || !fs || !prog) {
      if (!failedRef.current) { failedRef.current = true; onUnavailable(); }
      return;
    }
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      report(`shader failed to link — falling back to CSS: ${gl.getProgramInfoLog(prog)}`);
      if (!failedRef.current) { failedRef.current = true; onUnavailable(); }
      return;
    }
    gl.useProgram(prog);

    // One quad covering the canvas. Two triangles, four vertices, no indices.
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const u = {
      size: gl.getUniformLocation(prog, 'uSize'),
      time: gl.getUniformLocation(prog, 'uTime'),
      level: gl.getUniformLocation(prog, 'uLevel'),
      flow: gl.getUniformLocation(prog, 'uFlow'),
      deep: gl.getUniformLocation(prog, 'uDeep'),
      mid: gl.getUniformLocation(prog, 'uMid'),
      hot: gl.getUniformLocation(prog, 'uHot'),
    };

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Cap the pixel ratio. The shader is five octaves of 3D noise three times
    // over, so cost scales with every pixel drawn; past 2x nobody can see the
    // difference and a 4K screen would quadruple the bill for it.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
      gl.uniform2f(u.size, canvas.width, canvas.height);
    };

    // Reduced motion freezes the clock but still draws: the sphere is the only
    // thing on the screen, and removing it entirely would leave a blank panel.
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    let raf = 0;
    let stopped = false;
    let clock = 0;
    let last = performance.now();
    let announced = false;

    const frame = (now: number) => {
      if (stopped) return;
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      // Tool calls hurry the melt. The visible ring around the rim is the CSS
      // layer above; this is the fluid underneath reacting to the same event.
      if (!still) clock += dt * (workingRef.current ? 2.4 : 1);

      resize();
      if (!announced) {
        announced = true;
        // Success is worth a line too. Without it, "the sphere looks the same"
        // has two very different causes — the shader never mounted, or it
        // mounted and is being covered — and no way to tell them apart.
        report(`drawing ${canvas.width}x${canvas.height} (css ${canvas.clientWidth}x${canvas.clientHeight})`);
      }
      const pal = paletteRef.current;
      gl.uniform1f(u.time, clock);
      gl.uniform1f(u.level, levelRef.current ?? 0);
      gl.uniform1f(u.flow, FLOW[phaseRef.current] ?? 0.45);
      gl.uniform3fv(u.deep, toVec3(pal.deep));
      gl.uniform3fv(u.mid, toVec3(pal.mid));
      gl.uniform3fv(u.hot, toVec3(pal.hot));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    // A lost context is a black hole where the sphere was, and on Windows a
    // driver reset during a long call is not exotic. Preventing the default
    // lets the browser restore it; if it never comes back, fall back.
    const onLost = (e: Event) => {
      e.preventDefault();
      cancelAnimationFrame(raf);
    };
    const onRestored = () => {
      report('graphics context was lost mid-call — using the CSS sphere');
      if (!failedRef.current) { failedRef.current = true; onUnavailable(); }
    };
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);

    // Stop drawing while the window is hidden. A call left open in a background
    // window would otherwise keep a GPU busy for nothing.
    const onVisibility = () => {
      if (document.hidden) {
        stopped = true;
        cancelAnimationFrame(raf);
      } else if (stopped) {
        stopped = false;
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      document.removeEventListener('visibilitychange', onVisibility);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      // NOT `loseContext()`, however tidy it looks.
      //
      // A canvas hands out ONE context for its lifetime: `getContext` after a
      // forced loss returns the same, still-lost object. React reuses the
      // element across remounts, so killing the context here poisoned it for
      // every mount that followed — and on a lost context every call returns
      // null, which surfaces as "shader failed to compile" with an empty info
      // log. StrictMode's mount/unmount/remount made that happen on the very
      // first render, so the shader never ran once. The context dies with the
      // canvas; there is nothing here that needs freeing by hand.
    };
  }, [levelRef, onUnavailable]);

  return <canvas ref={canvasRef} aria-hidden className="absolute inset-0 h-full w-full" />;
}
