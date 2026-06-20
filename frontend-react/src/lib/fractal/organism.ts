/**
 * Custom escape-time organism renderer (WebGL2). Iterates z -> z^d + c with a
 * fractional, data-driven power d, smooth-iteration brand coloring, and
 * zoom-adaptive AA. Resolution-independent: the fragment shader recomputes per
 * pixel each draw, so vector zoom stays crisp within float32 precision. No
 * animation loop — the caller draws on demand (wheel/drag/impulse).
 */
import type { OrganismState } from '@/lib/fractal/signal';

export interface OrganismView {
  centerX: number;
  centerY: number;
  scale: number; // complex units per HALF the canvas height (smaller = deeper)
}

/** Opening view — the whole young organism centered, slightly left of origin. */
export const DEFAULT_VIEW: OrganismView = { centerX: -0.4, centerY: 0, scale: 1.3 };

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

const vec2 C_SEED = vec2(-0.8, 0.156);

// z^p for fractional p via polar form.
vec2 cpow(vec2 z, float p) {
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
  vec2 ceff = mix(c, C_SEED, u_morph);
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
  render(view: OrganismView, state: OrganismState): void;
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

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, canvas.width, canvas.height);
  };

  const ZOOMOUT_AA = 0.05;

  const render = (view: OrganismView, state: OrganismState) => {
    resize();
    gl.useProgram(prog);
    gl.bindVertexArray(vao);
    gl.uniform2f(u_res, canvas.width, canvas.height);
    gl.uniform2f(u_center, view.centerX, view.centerY);
    gl.uniform1f(u_scale, view.scale);
    const base = Math.floor(120 + 60 * Math.log2(1 / Math.max(view.scale, 1e-7)));
    const iter = Math.min(2048, Math.max(120, base + Math.max(0, Math.floor(state.depthBoost))));
    gl.uniform1i(u_maxIter, iter);
    gl.uniform1f(u_power, state.power);
    gl.uniform1f(u_morph, state.morph);
    gl.uniform1i(u_samples, view.scale > ZOOMOUT_AA ? 4 : 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  return { render, resize, dispose() {
    gl.deleteVertexArray(vao);
    gl.deleteProgram(prog); gl.deleteShader(vs); gl.deleteShader(fs); gl.deleteBuffer(buf);
  } };
}
