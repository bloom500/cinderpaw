/**
 * Custom escape-time organism renderer (WebGL2). Iterates z -> z^d + c with a
 * fractional, data-driven power d, smooth-iteration brand coloring, and
 * zoom-adaptive AA. Resolution-independent: the fragment shader recomputes per
 * pixel each draw, so vector zoom stays crisp within float32 precision. No
 * animation loop — the caller draws on demand (wheel/drag/impulse).
 */
import type { OrganismState, WarpSeed } from '@/lib/fractal/signal';

export const MAX_WARP = 32;

/** Pack warp seeds into fixed-length uniform arrays (clamped to MAX_WARP). */
export function packWarpUniforms(seeds: WarpSeed[]): { count: number; xy: Float32Array; sa: Float32Array } {
  const ranked = [...seeds].sort((a, b) => b.amp - a.amp);
  const count = Math.min(ranked.length, MAX_WARP);
  const xy = new Float32Array(MAX_WARP * 2);
  const sa = new Float32Array(MAX_WARP * 2);
  for (let i = 0; i < count; i++) {
    const s = ranked[i]!;
    xy[i * 2] = s.x; xy[i * 2 + 1] = s.y;
    sa[i * 2] = s.sigma; sa[i * 2 + 1] = s.amp;
  }
  return { count, xy, sa };
}

export interface OrganismView {
  centerX: number;
  centerY: number;
  scale: number; // complex units per HALF the canvas height (smaller = deeper)
}

/** Opening view. centerY is offset off the real axis so the (sheared) set's
 *  mirror line never sits dead-center — kills the perceived "doubling". */
export const DEFAULT_VIEW: OrganismView = { centerX: -0.6, centerY: 0.18, scale: 1.25 };

export function screenToComplex(px: number, py: number, width: number, height: number, v: OrganismView) {
  const aspect = width / height;
  const nx = (px / width) * 2 - 1;
  const ny = (py / height) * 2 - 1;
  return { x: v.centerX + nx * v.scale * aspect, y: v.centerY - ny * v.scale };
}

export function complexToScreen(x: number, y: number, width: number, height: number, v: OrganismView) {
  const aspect = width / height;
  const nx = (x - v.centerX) / (v.scale * aspect);
  const ny = -(y - v.centerY) / v.scale;
  return { px: ((nx + 1) / 2) * width, py: ((ny + 1) / 2) * height };
}

const VERT = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2  u_res;
uniform vec2  u_center;
uniform float u_scale;
uniform int   u_maxIter;
uniform float u_power;     // fractional multibrot power (2..8)
uniform float u_morph;     // 0..0.12 Julia blend
uniform int   u_samples;   // 1 or 4
uniform int  u_warpCount;
uniform vec2 u_warpXY[${MAX_WARP}];
uniform vec2 u_warpSA[${MAX_WARP}];   // (sigma, amp) per seed

const vec2 C_SEED = vec2(-0.8, 0.156);

// Breaks the z^p+c real-axis mirror (the "doubling") WITHOUT tilting: scales the
// upper/lower halves unequally via tanh (odd, smooth through y=0), so top and
// bottom diverge but the form stays upright. No horizontal shear → no lean.
const float YASYM = 0.10;

vec2 warp(vec2 c) {
  vec2 d = vec2(0.0);
  for (int i = 0; i < ${MAX_WARP}; i++) {
    if (i >= u_warpCount) break;
    vec2 diff = c - u_warpXY[i];
    float sigma = max(u_warpSA[i].x, 1e-3);
    float amp = u_warpSA[i].y;
    float g = exp(-dot(diff, diff) / (2.0 * sigma * sigma));
    vec2 rad = normalize(diff + vec2(1e-6));
    vec2 tang = vec2(-rad.y, rad.x);          // perpendicular → swirl handedness
    d += amp * g * (rad * 0.72 + tang * 0.34); // radial growth + asymmetric curl
  }
  return c + d * 0.15;
}

// z^p. Cheap exact path for p==2 (the rest power) — plain complex multiply,
// no transcendentals; polar form only for fractional powers (in-motion states).
vec2 cpow(vec2 z, float p) {
  if (abs(p - 2.0) < 0.001) return vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y);
  float r = length(z);
  if (r < 1e-12) return vec2(0.0);
  float a = atan(z.y, z.x);
  float rp = pow(r, p);
  return vec2(rp * cos(p * a), rp * sin(p * a));
}

vec3 palette(float t) {
  vec3 red    = vec3(0.45, 0.06, 0.03);
  vec3 orange = vec3(0.92, 0.45, 0.06);
  vec3 amber  = vec3(1.00, 0.72, 0.25);
  vec3 cream  = vec3(1.00, 0.96, 0.86);
  vec3 c = mix(red, orange, smoothstep(0.0, 0.45, t));
  c = mix(c, amber, smoothstep(0.4, 0.8, t));
  c = mix(c, cream, smoothstep(0.85, 1.0, t));
  return c;
}

float escape(vec2 c) {
  vec2 ceff = mix(warp(c), C_SEED, u_morph);
  ceff.y *= 1.0 + YASYM * tanh(ceff.y * 2.0);   // break mirror, upright (no tilt)
  vec2 z = vec2(0.0);
  int i = 0;
  const float BAIL = 256.0;
  for (int n = 0; n < 2048; n++) {
    if (n >= u_maxIter) break;
    z = cpow(z, u_power) + ceff;
    if (dot(z, z) > BAIL) break;
    i++;
  }
  if (i >= u_maxIter) return -1.0;
  float mu = float(i) + 1.0 - log2(log2(dot(z, z)) * 0.5);
  return clamp(mu / float(u_maxIter), 0.0, 1.0);
}

vec3 shade(float t) {
  if (t < 0.0) return vec3(0.02, 0.02, 0.03);
  return palette(pow(t, 0.5));
}

void main() {
  float aspect = u_res.x / u_res.y;
  vec3 acc = vec3(0.0);
  for (int sy = 0; sy < 2; sy++) {
    for (int sx = 0; sx < 2; sx++) {
      if (u_samples == 1 && (sx != 0 || sy != 0)) continue;
      vec2 off = (u_samples == 1) ? vec2(0.0) : (vec2(float(sx), float(sy)) - 0.5) * 0.5;
      vec2 ndc = ((gl_FragCoord.xy + off) / u_res) * 2.0 - 1.0;
      vec2 c = u_center + vec2(ndc.x * u_scale * aspect, ndc.y * u_scale);
      acc += shade(escape(c));
    }
  }
  float div = (u_samples == 1) ? 1.0 : 4.0;
  outColor = vec4(acc / div, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error('organism shader compile failed:', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

export interface OrganismRenderer {
  /** `interacting` trades quality for speed during pan/zoom (1 sample, DPR 1,
   *  fewer iterations); draw again without it to settle to full quality. */
  render(view: OrganismView, state: OrganismState, opts?: { interacting?: boolean }): void;
  resize(): void;
  dispose(): void;
}

export function createOrganismRenderer(canvas: HTMLCanvasElement): OrganismRenderer | null {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
  if (!gl) return null;
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return null;
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('organism program link failed:', gl.getProgramInfoLog(prog));
    return null;
  }
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const loc = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const U = (n: string) => gl.getUniformLocation(prog, n);
  const u_res = U('u_res'), u_center = U('u_center'), u_scale = U('u_scale');
  const u_maxIter = U('u_maxIter'), u_power = U('u_power'), u_morph = U('u_morph'), u_samples = U('u_samples');
  const u_warpCount = U('u_warpCount'), u_warpXY = U('u_warpXY'), u_warpSA = U('u_warpSA');

  const resize = (lowRes = false) => {
    const dpr = Math.min(window.devicePixelRatio || 1, lowRes ? 1 : 2);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, canvas.width, canvas.height);
  };

  const ZOOMOUT_AA = 0.05;

  const render = (view: OrganismView, state: OrganismState, opts?: { interacting?: boolean }) => {
    const interacting = opts?.interacting ?? false;
    resize(interacting);
    gl.useProgram(prog);
    gl.bindVertexArray(vao);
    gl.uniform2f(u_res, canvas.width, canvas.height);
    gl.uniform2f(u_center, view.centerX, view.centerY);
    gl.uniform1f(u_scale, view.scale);
    const base = Math.floor(120 + 60 * Math.log2(1 / Math.max(view.scale, 1e-7)));
    // Iteration count stays constant across interacting/settled so the set
    // boundary never shifts — otherwise the shape visibly pulses on pan/zoom.
    const iter = Math.min(2048, Math.max(120, base + Math.max(0, Math.floor(state.depthBoost))));
    gl.uniform1i(u_maxIter, iter);
    gl.uniform1f(u_power, state.power);
    gl.uniform1f(u_morph, state.morph);
    gl.uniform1i(u_samples, interacting ? 1 : (view.scale > ZOOMOUT_AA ? 4 : 1));
    const warp = packWarpUniforms(state.warpSeeds);
    gl.uniform1i(u_warpCount, warp.count);
    gl.uniform2fv(u_warpXY, warp.xy);
    gl.uniform2fv(u_warpSA, warp.sa);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  return { render, resize, dispose() {
    gl.deleteVertexArray(vao);
    gl.deleteProgram(prog); gl.deleteShader(vs); gl.deleteShader(fs); gl.deleteBuffer(buf);
  } };
}
