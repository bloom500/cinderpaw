/**
 * Raw WebGL2 Mandelbrot renderer with smooth (normalized) iteration coloring.
 * Resolution-independent: the fragment shader recomputes z→z²+c per pixel at
 * the current view every draw, so zoom never pixelates. NO animation — the
 * caller draws only in response to user input (wheel/drag/reset).
 */

export interface View {
  centerX: number;   // complex-plane center (real)
  centerY: number;   // complex-plane center (imag)
  scale: number;     // complex units per HALF the canvas height (smaller = deeper)
}

export type FractalTheme = 'light' | 'dark';

/** Opening region: Seahorse Valley (matches the light reference). */
export const SEAHORSE_VIEW: View = { centerX: -0.745, centerY: 0.113, scale: 0.9 };
export const ELEPHANT_VIEW: View = { centerX: 0.275, centerY: 0.007, scale: 0.15 };
export const MINIBROT_VIEW: View = { centerX: -0.7451, centerY: 0.1132, scale: 0.0008 };

/** Pixel (px,py) → complex coordinate, preserving aspect ratio. Origin px=0,py=0
 *  is top-left; the imaginary axis points up (py increases downward). */
export function screenToComplex(px: number, py: number, width: number, height: number, v: View) {
  const aspect = width / height;
  const nx = (px / width) * 2 - 1;        // -1..1 across width
  const ny = (py / height) * 2 - 1;       // -1..1 down height
  return {
    x: v.centerX + nx * v.scale * aspect,
    y: v.centerY - ny * v.scale,          // flip so up = +imag
  };
}

/** Inverse of screenToComplex. */
export function complexToScreen(x: number, y: number, width: number, height: number, v: View) {
  const aspect = width / height;
  const nx = (x - v.centerX) / (v.scale * aspect);
  const ny = -(y - v.centerY) / v.scale;
  return {
    px: ((nx + 1) / 2) * width,
    py: ((ny + 1) / 2) * height,
  };
}

const VERT = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

// Smooth-iteration Mandelbrot. Palette chosen by u_theme (0=light,1=dark).
const FRAG = `#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2  u_res;      // canvas pixels
uniform vec2  u_center;   // complex center
uniform float u_scale;    // complex units per half-height
uniform int   u_theme;    // 0 light, 1 dark
uniform int   u_maxIter;

vec3 lightPalette(float t) {
  // near-white lavender field → blue-violet → periwinkle filigree
  vec3 field  = vec3(0.918, 0.910, 0.949);
  vec3 violet = vec3(0.357, 0.373, 0.682);
  vec3 peri   = vec3(0.604, 0.627, 0.878);
  vec3 c = mix(field, peri, smoothstep(0.0, 0.5, t));
  c = mix(c, violet, smoothstep(0.4, 1.0, t));
  return c;
}
vec3 darkPalette(float t) {
  // black → deep red → orange → amber → cream ember (Feral brand)
  vec3 red    = vec3(0.45, 0.06, 0.03);
  vec3 orange = vec3(0.92, 0.45, 0.06);
  vec3 amber  = vec3(1.00, 0.72, 0.25);
  vec3 cream  = vec3(1.00, 0.96, 0.86);
  vec3 c = mix(red, orange, smoothstep(0.0, 0.45, t));
  c = mix(c, amber, smoothstep(0.4, 0.8, t));
  c = mix(c, cream, smoothstep(0.85, 1.0, t));
  return c;
}

void main() {
  float aspect = u_res.x / u_res.y;
  vec2 ndc = (gl_FragCoord.xy / u_res) * 2.0 - 1.0;   // -1..1
  vec2 c = u_center + vec2(ndc.x * u_scale * aspect, ndc.y * u_scale);

  vec2 z = vec2(0.0);
  int i = 0;
  const float BAIL = 256.0;
  for (int n = 0; n < 2048; n++) {
    if (n >= u_maxIter) break;
    z = vec2(z.x*z.x - z.y*z.y, 2.0*z.x*z.y) + c;
    if (dot(z, z) > BAIL) break;
    i++;
  }

  vec3 interior = (u_theme == 1) ? vec3(0.02, 0.02, 0.03) : vec3(0.05, 0.05, 0.09);
  if (i >= u_maxIter) { outColor = vec4(interior, 1.0); return; }

  // Normalized (smooth) iteration count.
  float mu = float(i) + 1.0 - log2(log2(dot(z, z)) * 0.5);
  float t = clamp(mu / float(u_maxIter), 0.0, 1.0);
  t = pow(t, 0.5); // perceptual lift so detail near the boundary reads

  vec3 col = (u_theme == 1) ? darkPalette(t) : lightPalette(t);
  outColor = vec4(col, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error('shader compile failed:', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

export interface MandelbrotRenderer {
  render(view: View, theme: FractalTheme): void;
  resize(): void;
  dispose(): void;
}

/** Create the renderer, or null if WebGL2 isn't available (caller shows a
 *  static fallback). The caller owns the draw cadence — there is no loop. */
export function createMandelbrotRenderer(canvas: HTMLCanvasElement): MandelbrotRenderer | null {
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
    console.error('program link failed:', gl.getProgramInfoLog(prog));
    return null;
  }

  // Fullscreen triangle.
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const u_res = gl.getUniformLocation(prog, 'u_res');
  const u_center = gl.getUniformLocation(prog, 'u_center');
  const u_scale = gl.getUniformLocation(prog, 'u_scale');
  const u_theme = gl.getUniformLocation(prog, 'u_theme');
  const u_maxIter = gl.getUniformLocation(prog, 'u_maxIter');

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
  };

  const render = (view: View, theme: FractalTheme) => {
    resize();
    gl.useProgram(prog);
    gl.uniform2f(u_res, canvas.width, canvas.height);
    gl.uniform2f(u_center, view.centerX, view.centerY);
    gl.uniform1f(u_scale, view.scale);
    gl.uniform1i(u_theme, theme === 'dark' ? 1 : 0);
    // More iterations as we zoom in (deeper detail) — bounded by the loop cap.
    const iter = Math.min(2048, Math.floor(120 + 60 * Math.log2(1 / Math.max(view.scale, 1e-7))));
    gl.uniform1i(u_maxIter, Math.max(120, iter));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  return {
    render,
    resize,
    dispose() {
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buf);
    },
  };
}
