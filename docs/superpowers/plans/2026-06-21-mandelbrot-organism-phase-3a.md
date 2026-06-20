# Mandelbrot Organism — Phase 3a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Memory Layers screen with a pure, data-driven escape-time organism (custom `z^d + c` multibrot) that grows with the agent's memory and pulses on events — no text, no nodes, no inspection UI.

**Architecture:** A new WebGL2 renderer (`organism.ts`, built from scratch, resolution-independent) draws a fractional-power multibrot whose power/depth/morph come from a pure signal function (`deriveOrganismState`). The page composes only the canvas + a Refresh control; event impulses ease the organism between states using the existing transition hook. Phase 3a drives the form from the memory-graph (node count + distinct node-type diversity); cluster-positioned domain-warp filaments are Phase 3b.

**Tech Stack:** React + TypeScript, WebGL2 (GLSL ES 3.00), Vitest, Tauri IPC (`@/lib/tauri`).

## Global Constraints

- Frontend dir: `frontend-react/`. All paths below are relative to it unless absolute.
- Test runner: Vitest. Run a single file with `npx vitest run <path>`. Typecheck with `npx tsc --noEmit`.
- Vitest imports: `import { describe, it, expect } from 'vitest';`.
- Path alias `@/` → `frontend-react/src/`.
- No idle animation: no persistent `requestAnimationFrame` loop at rest; motion is event-triggered and self-terminating.
- Resolution-independent: the fragment shader recomputes escape-time per pixel each draw (never a scaled bitmap). Accept the float32 deep-zoom limit (~`scale < 1e-5`).
- Zero text/labels/nodes rendered on the organism screen.
- Brand palette: black background, orange family (red→orange→amber→cream by smooth iteration).
- Commit after every task. Branch: `feat/rsi-fractal-memory`.

---

### Task 1: `deriveOrganismState` pure signal function

Adds the data→form mapping (power + depth + morph). Pure, fully unit-tested. The monotonic-floor logic mirrors the existing `deriveFractalState` in the same file.

**Files:**
- Modify: `src/lib/fractal/signal.ts`
- Test: `src/lib/fractal/__tests__/organism-signal.test.ts` (create)

**Interfaces:**
- Consumes: `RsiStatus` from `@/lib/tauri` (existing; has optional `engine.iteration: number` and `bounds_version: number`).
- Produces:
  - `interface OrganismState { power: number; depthBoost: number; morph: number; warpSeeds: WarpSeed[] }`
  - `interface WarpSeed { x: number; y: number; sigma: number; amp: number }`
  - `interface OrganismInput { clusterCount: number; eliteNodeCount: number; rsi: RsiStatus | null; persistedFloor: number; clusters?: { x: number; y: number; weight: number }[] }`
  - `interface DerivedOrganism { state: OrganismState; floor: number }`
  - `function deriveOrganismState(input: OrganismInput): DerivedOrganism`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/fractal/__tests__/organism-signal.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { deriveOrganismState } from '@/lib/fractal/signal';
import type { RsiStatus } from '@/lib/tauri';

const noRsi = null;
const rsiWith = (iteration: number, bounds_version = 0): RsiStatus =>
  ({ engine: { iteration }, bounds_version } as unknown as RsiStatus);

describe('deriveOrganismState — power (arms from diversity)', () => {
  it('newborn (no clusters) → power 2', () => {
    const { state } = deriveOrganismState({ clusterCount: 0, eliteNodeCount: 0, rsi: noRsi, persistedFloor: 0 });
    expect(state.power).toBe(2);
  });
  it('power rises with clusterCount', () => {
    const a = deriveOrganismState({ clusterCount: 2, eliteNodeCount: 0, rsi: noRsi, persistedFloor: 0 }).state.power;
    const b = deriveOrganismState({ clusterCount: 32, eliteNodeCount: 0, rsi: noRsi, persistedFloor: 0 }).state.power;
    expect(b).toBeGreaterThan(a);
  });
  it('power is clamped to 8', () => {
    const { state } = deriveOrganismState({ clusterCount: 100000, eliteNodeCount: 0, rsi: noRsi, persistedFloor: 0 });
    expect(state.power).toBeLessThanOrEqual(8);
  });
});

describe('deriveOrganismState — floor (monotonic maturity)', () => {
  it('floor never drops below persistedFloor even if signals shrink', () => {
    const { floor } = deriveOrganismState({ clusterCount: 0, eliteNodeCount: 0, rsi: rsiWith(0), persistedFloor: 500 });
    expect(floor).toBeGreaterThanOrEqual(500);
  });
  it('a bounds_version bump raises the floor and it stays raised after a node drop', () => {
    const bumped = deriveOrganismState({ clusterCount: 10, eliteNodeCount: 100, rsi: rsiWith(10, 3), persistedFloor: 0 }).floor;
    const later = deriveOrganismState({ clusterCount: 1, eliteNodeCount: 1, rsi: rsiWith(10, 3), persistedFloor: bumped }).floor;
    expect(later).toBeGreaterThanOrEqual(bumped);
  });
});

describe('deriveOrganismState — depth + extinction', () => {
  it('depthBoost shrinks when eliteNodeCount shrinks but stays >= floor', () => {
    const big = deriveOrganismState({ clusterCount: 5, eliteNodeCount: 500, rsi: rsiWith(50), persistedFloor: 0 });
    const small = deriveOrganismState({ clusterCount: 5, eliteNodeCount: 5, rsi: rsiWith(50), persistedFloor: big.floor });
    expect(small.state.depthBoost).toBeLessThan(big.state.depthBoost);
    expect(small.state.depthBoost).toBeGreaterThanOrEqual(small.floor);
  });
});

describe('deriveOrganismState — graceful null', () => {
  it('rsi null → morph 0 and no crash', () => {
    const { state } = deriveOrganismState({ clusterCount: 3, eliteNodeCount: 10, rsi: noRsi, persistedFloor: 0 });
    expect(state.morph).toBe(0);
  });
  it('morph is clamped to 0.12', () => {
    const { state } = deriveOrganismState({ clusterCount: 3, eliteNodeCount: 10, rsi: rsiWith(1_000_000), persistedFloor: 0 });
    expect(state.morph).toBeLessThanOrEqual(0.12);
  });
  it('warpSeeds empty when no clusters provided', () => {
    const { state } = deriveOrganismState({ clusterCount: 3, eliteNodeCount: 10, rsi: noRsi, persistedFloor: 0 });
    expect(state.warpSeeds).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/fractal/__tests__/organism-signal.test.ts`
Expected: FAIL — `deriveOrganismState is not a function` (not yet exported).

- [ ] **Step 3: Implement `deriveOrganismState`**

Append to `src/lib/fractal/signal.ts` (keep the existing `deriveFractalState`):

```ts
/** A Gaussian domain-warp seed at a cluster's complex-plane position (Phase 3b). */
export interface WarpSeed { x: number; y: number; sigma: number; amp: number }

/** Organism rendering parameters derived from memory + RSI state. */
export interface OrganismState {
  /** Fractional multibrot power (2 = disc/two-lobe, higher = more arms). */
  power: number;
  /** Added to the zoom-driven iteration count (deeper structure). */
  depthBoost: number;
  /** Julia interpolation factor in [0, 0.12]; 0 at rest, eased up on impulse. */
  morph: number;
  /** Cluster-positioned warp seeds (Phase 3b); empty in 3a / pre-tree. */
  warpSeeds: WarpSeed[];
}

export interface OrganismInput {
  /** Distinct memory clusters (RAPTOR top level; a node-type-count proxy in 3a). */
  clusterCount: number;
  /** Surviving (post-prune / "elite") node count — the reactive volume. */
  eliteNodeCount: number;
  /** RSI status; null (or engine === null) when not wired. */
  rsi: RsiStatus | null;
  /** Current persisted monotonic floor (from the maturity store). */
  persistedFloor: number;
  /** Cluster positions for warp seeds (Phase 3b); omitted/empty in 3a. */
  clusters?: { x: number; y: number; weight: number }[];
}

export interface DerivedOrganism {
  state: OrganismState;
  /** New monotonic floor to persist (>= persistedFloor). */
  floor: number;
}

// Tuning (see spec §Signal Mapping).
const POWER_MIN = 2;
const POWER_MAX = 8;
const POWER_K = 0.9;          // power gain per log2 unit of clusters
const WARP_SIGMA = 0.12;      // base Gaussian width per warp seed (Phase 3b)

export function deriveOrganismState(input: OrganismInput): DerivedOrganism {
  const { clusterCount, eliteNodeCount, rsi, persistedFloor, clusters } = input;
  const engine = rsi?.engine ?? null;
  const iter = engine?.iteration ?? 0;
  const boundsVersion = rsi?.bounds_version ?? 0;

  const power = Math.min(
    POWER_MAX,
    Math.max(POWER_MIN, POWER_MIN + POWER_K * Math.log2(1 + Math.max(0, clusterCount))),
  );

  const floorCandidate = FLOOR_ITER_A * iter + FLOOR_BOUNDS_B * boundsVersion;
  const floor = Math.max(persistedFloor, floorCandidate, 0);

  const reactive = eliteNodeCount <= 0 ? 0 : REACTIVE_K * Math.log2(1 + eliteNodeCount);
  const depthBoost = Math.max(floor, floor + reactive);

  const morph = engine === null ? 0 : Math.min(MORPH_MAX, Math.max(0, MORPH_ITER_G * iter));

  const warpSeeds: WarpSeed[] = (clusters ?? []).map((c) => ({
    x: c.x,
    y: c.y,
    sigma: WARP_SIGMA,
    amp: Math.max(0, c.weight),
  }));

  return { state: { power, depthBoost, morph, warpSeeds }, floor };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/fractal/__tests__/organism-signal.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit` (expected: no new errors)
```bash
git add src/lib/fractal/signal.ts src/lib/fractal/__tests__/organism-signal.test.ts
git commit -m "feat(viz): deriveOrganismState — data-driven organism signal (power/depth/morph)"
```

---

### Task 2: `organism.ts` — custom escape-time WebGL2 renderer

A from-scratch renderer for `z^d + c` with fractional power, smooth-iteration brand coloring, zoom-adaptive AA, resolution-independent. The pure projection helpers are unit-tested; the shader itself is verified by build + visual run.

**Files:**
- Create: `src/lib/fractal/organism.ts`
- Test: `src/lib/fractal/__tests__/organism-projection.test.ts` (create)

**Interfaces:**
- Consumes: `OrganismState` from `@/lib/fractal/signal`.
- Produces:
  - `interface OrganismView { centerX: number; centerY: number; scale: number }`
  - `function screenToComplex(px, py, width, height, v: OrganismView): { x: number; y: number }`
  - `function complexToScreen(x, y, width, height, v: OrganismView): { px: number; py: number }`
  - `const DEFAULT_VIEW: OrganismView`
  - `interface OrganismRenderer { render(view: OrganismView, state: OrganismState): void; resize(): void; dispose(): void }`
  - `function createOrganismRenderer(canvas: HTMLCanvasElement): OrganismRenderer | null` (null when WebGL2 is unavailable)

- [ ] **Step 1: Write the failing projection tests**

Create `src/lib/fractal/__tests__/organism-projection.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { screenToComplex, complexToScreen, DEFAULT_VIEW } from '@/lib/fractal/organism';

describe('organism projection', () => {
  const W = 800, H = 600;
  it('screen center maps to the view center', () => {
    const c = screenToComplex(W / 2, H / 2, W, H, DEFAULT_VIEW);
    expect(c.x).toBeCloseTo(DEFAULT_VIEW.centerX, 6);
    expect(c.y).toBeCloseTo(DEFAULT_VIEW.centerY, 6);
  });
  it('complexToScreen inverts screenToComplex', () => {
    const v = { centerX: -0.4, centerY: 0.15, scale: 0.01 };
    const c = screenToComplex(123, 456, W, H, v);
    const s = complexToScreen(c.x, c.y, W, H, v);
    expect(s.px).toBeCloseTo(123, 4);
    expect(s.py).toBeCloseTo(456, 4);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/fractal/__tests__/organism-projection.test.ts`
Expected: FAIL — cannot import from `organism` (file does not exist).

- [ ] **Step 3: Implement `organism.ts`**

Create `src/lib/fractal/organism.ts`:

```ts
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
    gl.deleteProgram(prog); gl.deleteShader(vs); gl.deleteShader(fs); gl.deleteBuffer(buf);
  } };
}
```

- [ ] **Step 4: Run the projection tests to verify they pass**

Run: `npx vitest run src/lib/fractal/__tests__/organism-projection.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit` (expected: no new errors)
```bash
git add src/lib/fractal/organism.ts src/lib/fractal/__tests__/organism-projection.test.ts
git commit -m "feat(viz): organism.ts — custom z^d+c escape-time WebGL2 renderer"
```

---

### Task 3: Rewrite `MemoryLayersPage` as the pure organism

Strip all node/text/search/detail UI; compose only the organism canvas with pan/zoom + a Refresh control. Wire the data source (graph node count + distinct node types as the cluster proxy in 3a) and the persisted maturity floor.

**Files:**
- Modify (rewrite): `src/pages/MemoryLayersPage.tsx`
- Reference (no change): `src/lib/fractal/maturity.ts`, `src/lib/fractal/useFractalTransition.ts`

**Interfaces:**
- Consumes: `createOrganismRenderer`, `DEFAULT_VIEW`, `screenToComplex`, `OrganismView` (Task 2); `deriveOrganismState`, `OrganismState` (Task 1); `maturity` store; `tauri.memory.getGraph()`, `tauri.rsi.status()`.
- Produces: the default-exported `MemoryLayersPage` React component (route target — keep the export name/signature unchanged).

- [ ] **Step 1: Confirm the current export + route name**

Run: `grep -n "export default function MemoryLayersPage\|MemoryLayersPage" src/router.tsx src/pages/MemoryLayersPage.tsx`
Expected: a default export used by the router. Preserve that exact name and default-export form.

- [ ] **Step 2: Rewrite the page**

Replace the entire contents of `src/pages/MemoryLayersPage.tsx` with:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { tauri } from '@/lib/tauri';
import {
  createOrganismRenderer,
  DEFAULT_VIEW,
  type OrganismRenderer,
  type OrganismView,
} from '@/lib/fractal/organism';
import { deriveOrganismState, type OrganismState } from '@/lib/fractal/signal';
import { maturity } from '@/lib/fractal/maturity';

const REST_STATE: OrganismState = { power: 2, depthBoost: 0, morph: 0, warpSeeds: [] };

export default function MemoryLayersPage() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<OrganismRenderer | null>(null);
  const viewRef = useRef<OrganismView>({ ...DEFAULT_VIEW });
  const stateRef = useRef<OrganismState>(REST_STATE);
  const [loading, setLoading] = useState(false);
  const [unsupported, setUnsupported] = useState(false);

  const draw = useCallback(() => {
    rendererRef.current?.render(viewRef.current, stateRef.current);
  }, []);

  // One-time renderer setup.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const r = createOrganismRenderer(canvas);
    if (!r) { setUnsupported(true); return; }
    rendererRef.current = r;
    draw();
    const onResize = () => { r.resize(); draw(); };
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); r.dispose(); rendererRef.current = null; };
  }, [draw]);

  // Pull memory + RSI state and recompute the organism form.
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [graph, rsi] = await Promise.all([
        tauri.memory.getGraph(),
        tauri.rsi.status().catch(() => null),
      ]);
      const eliteNodeCount = graph.nodes.length;
      const clusterCount = new Set(graph.nodes.map((n) => n.type)).size; // diversity proxy (3a)
      const { state, floor } = deriveOrganismState({
        clusterCount,
        eliteNodeCount,
        rsi,
        persistedFloor: maturity.current(),
      });
      maturity.bump(floor);
      stateRef.current = state;
      draw();
    } finally {
      setLoading(false);
    }
  }, [draw]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Pan / zoom — pure vector navigation of the organism.
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.1 : 1 / 1.1;
    viewRef.current = { ...viewRef.current, scale: Math.max(1e-7, viewRef.current.scale * factor) };
    draw();
  }, [draw]);

  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => { dragRef.current = { x: e.clientX, y: e.clientY }; };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current; if (!d) return;
    const canvas = canvasRef.current; if (!canvas) return;
    const v = viewRef.current;
    const aspect = canvas.clientWidth / canvas.clientHeight;
    viewRef.current = {
      ...v,
      centerX: v.centerX - ((e.clientX - d.x) / canvas.clientWidth) * 2 * v.scale * aspect,
      centerY: v.centerY + ((e.clientY - d.y) / canvas.clientHeight) * 2 * v.scale,
    };
    dragRef.current = { x: e.clientX, y: e.clientY };
    draw();
  };
  const onPointerUp = () => { dragRef.current = null; };

  if (unsupported) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-black">
        <p className="text-xs text-text-muted">WebGL2 unavailable — organism view disabled.</p>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full touch-none"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      />
      <button
        type="button"
        onClick={() => void refresh()}
        disabled={loading}
        aria-label="Refresh organism"
        className="absolute top-4 right-4 z-10 rounded-lg border border-border-subtle bg-bg-surface/70 backdrop-blur p-2 text-text-secondary hover:text-text-primary disabled:opacity-50"
      >
        <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: errors ONLY about now-unused imports/files (FilamentText, layout, diff, old signal/mandelbrot symbols) — these are removed in Task 5. No errors inside `MemoryLayersPage.tsx` itself. If `graph.nodes[].type` is typed differently, adjust the `.type` access to the real field on `MemoryGraphSnapshot` (check `@/lib/tauri` types).

- [ ] **Step 4: Visual verification**

Run: `npm run dev`, open the Memory Layers route. Expected: a black screen with the orange organism; mouse wheel zooms in with crisp detail (no pixelation until very deep), drag pans, Refresh re-pulls state. No text/nodes anywhere.

- [ ] **Step 5: Commit**

```bash
git add src/pages/MemoryLayersPage.tsx
git commit -m "feat(viz): rewrite Memory Layers as the pure organism (no text/nodes/UI)"
```

---

### Task 4: Event impulses (live evolution)

Make the organism pulse on discrete events (RSI iteration / memory change), easing from the previous state to the freshly-derived one over ~1.5 s, then settle. No idle loop.

**Files:**
- Create: `src/hooks/useOrganismImpulse.ts`
- Modify: `src/pages/MemoryLayersPage.tsx`

**Interfaces:**
- Consumes: `OrganismState` (Task 1); a per-frame draw callback and the current/target states from the page.
- Produces: `function useOrganismImpulse(opts: { onFrame: (s: OrganismState) => void; durationMs?: number }): { impulseTo: (from: OrganismState, to: OrganismState) => void }`

- [ ] **Step 1: Write the impulse hook**

Create `src/hooks/useOrganismImpulse.ts`:

```ts
import { useCallback, useEffect, useRef } from 'react';
import type { OrganismState } from '@/lib/fractal/signal';

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Animate the organism from one state to another over a short, self-settling
 * impulse (one rAF run, then cancelled). No persistent loop — idle = frozen.
 */
export function useOrganismImpulse(opts: { onFrame: (s: OrganismState) => void; durationMs?: number }) {
  const { onFrame, durationMs = 1500 } = opts;
  const rafRef = useRef<number | null>(null);
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); }, []);

  const impulseTo = useCallback((from: OrganismState, to: OrganismState) => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    const start = performance.now();
    const tick = (now: number) => {
      const raw = Math.min(1, (now - start) / durationMs);
      const t = easeOutCubic(raw);
      // morph blips up then back to the target (a breath) while structure eases in.
      const breath = Math.sin(raw * Math.PI) * 0.12;
      onFrameRef.current({
        power: lerp(from.power, to.power, t),
        depthBoost: lerp(from.depthBoost, to.depthBoost, t),
        morph: Math.min(0.12, lerp(from.morph, to.morph, t) + breath),
        warpSeeds: to.warpSeeds,
      });
      if (raw < 1) { rafRef.current = requestAnimationFrame(tick); }
      else { rafRef.current = null; onFrameRef.current(to); }
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [durationMs]);

  return { impulseTo };
}
```

- [ ] **Step 2: Wire impulses into the page**

In `src/pages/MemoryLayersPage.tsx`, import the hook and use it so `refresh` eases instead of snapping. Add the import:

```tsx
import { useOrganismImpulse } from '@/hooks/useOrganismImpulse';
```

Inside the component, after `draw` is defined, add:

```tsx
  const { impulseTo } = useOrganismImpulse({
    onFrame: (s) => { stateRef.current = s; draw(); },
  });
```

Then in `refresh`, replace the lines:

```tsx
      stateRef.current = state;
      draw();
```

with:

```tsx
      impulseTo(stateRef.current, state);
```

- [ ] **Step 3: Subscribe to RSI engine events for live pulses**

Confirm the event name first:

Run: `grep -rn "rsi_engine_event\|feral://rsi\|listen(" src/lib/tauri/*.ts src/pages/MemoryLayersPage.tsx | head`

Then, inside the component, add an effect that re-derives + impulses on each RSI engine event. Use whichever subscription the codebase already exposes (Tauri `listen` for a `feral://rsi-*` event, or a polling fallback). Add:

```tsx
  // Live evolution: re-pull + pulse whenever the RSI engine reports progress.
  useEffect(() => {
    let alive = true;
    const unlistenP = tauri.events.onRsiEngineEvent?.(() => { if (alive) void refresh(); });
    return () => { alive = false; void unlistenP?.then?.((u: () => void) => u?.()); };
  }, [refresh]);
```

If `tauri.events.onRsiEngineEvent` does not exist, add a thin binding in `@/lib/tauri` that wraps the existing Tauri `listen` for the RSI engine event channel (mirror how other `feral://` events are subscribed in the file), then use it here. Do NOT add a polling loop (violates no-idle-animation).

- [ ] **Step 4: Typecheck + visual verification**

Run: `npx tsc --noEmit` (expected: clean, modulo the dead-code removals in Task 5)
Run: `npm run dev` — trigger an RSI iteration (or click Refresh) and confirm the organism eases/pulses for ~1.5 s then holds still (no continuous motion when idle).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useOrganismImpulse.ts src/pages/MemoryLayersPage.tsx src/lib/tauri/index.ts
git commit -m "feat(viz): event-pulsed live evolution for the organism (idle = frozen)"
```

---

### Task 5: Remove dead visualization code

Delete the text/node machinery the pure organism replaced, and any now-unused fractal helpers.

**Files:**
- Delete: `src/components/memory/FilamentText.tsx`
- Delete (if unused): `src/lib/fractal/layout.ts`, `src/lib/fractal/diff.ts`, `src/lib/fractal/useFractalTransition.ts`, `src/components/memory/MandelbrotCanvas.tsx`, `src/lib/fractal/mandelbrot.ts` and its test
- Modify: remove now-dead `deriveFractalState`/`FractalState` from `src/lib/fractal/signal.ts` if nothing imports them

- [ ] **Step 1: Find remaining references to each candidate**

Run, for each file's exported symbol:
```bash
grep -rn "FilamentText\|MandelbrotCanvas\|useFractalTransition\|deriveFractalState\|from '@/lib/fractal/layout'\|from '@/lib/fractal/diff'\|from '@/lib/fractal/mandelbrot'" src/
```
Expected: after Tasks 3–4, the only hits are the definitions themselves (and `useFractalTransition` only if Task 4 didn't use it — this plan uses `useOrganismImpulse` instead, so it should be unused).

- [ ] **Step 2: Delete the unused files**

```bash
git rm src/components/memory/FilamentText.tsx
git rm src/components/memory/MandelbrotCanvas.tsx
git rm src/lib/fractal/mandelbrot.ts src/lib/fractal/__tests__/mandelbrot.test.ts
git rm src/lib/fractal/layout.ts src/lib/fractal/diff.ts src/lib/fractal/useFractalTransition.ts
```
(Only `git rm` the files that Step 1 confirmed have no remaining importers. If one still has a referrer, leave it and note why.)

- [ ] **Step 3: Drop dead exports from signal.ts**

If Step 1 showed no importers of `deriveFractalState`/`FractalState`/`DerivedFractal`/`FractalSignalInput`, remove those declarations from `src/lib/fractal/signal.ts`, keeping only the organism exports and the shared tuning constants they use.

- [ ] **Step 4: Typecheck + full test + build**

Run: `npx tsc --noEmit` → expected: clean.
Run: `npx vitest run` → expected: all pass (organism-signal + organism-projection green; deleted mandelbrot test gone).
Run: `npm run build` → expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(viz): remove text/node fractal code superseded by the organism"
```

---

## Self-Review

**Spec coverage:**
- Pure organism / no text/nodes/UI → Task 3 (rewrite) + Task 5 (removal). ✓
- Custom `z^d + c` escape-time, vector zoom → Task 2. ✓
- Power from diversity, depth from maturity floor + elite volume, morph → Task 1. ✓
- Event-pulsed self-settling motion, idle frozen → Task 4. ✓
- Extinction (retraction) → emergent from Task 1 (power/reactive drop) + Task 4 easing; no separate task needed (no special-case code — the same derive+impulse path animates downward). ✓
- Graceful null / pre-tree degradation → Task 1 (null handling) + Task 3 (graph fallback, node-type proxy for clusterCount). ✓
- Brand palette, resolution independence, float32 limit accepted → Task 2. ✓
- Cluster domain-warp filaments (3b) → intentionally OUT of this plan (separate plan after 3a lands); `warpSeeds` plumbed through Task 1 but unused by the shader until 3b.

**Placeholder scan:** Task 4 Step 3 leaves the exact RSI-event binding to discover-and-mirror because the subscription API differs across the codebase; the step gives the exact grep, the exact effect code, and a precise fallback rule (wrap existing `listen`, no polling). All other steps contain complete code.

**Type consistency:** `OrganismState` (power, depthBoost, morph, warpSeeds) is produced in Task 1 and consumed unchanged in Tasks 2–4. `OrganismView` defined in Task 2, used in Task 3. `deriveOrganismState` / `createOrganismRenderer` / `DEFAULT_VIEW` / `useOrganismImpulse` names are consistent across tasks.

## Notes for Phase 3b (separate plan, later)

Add a `fractal_tree_stats` IPC (top-level cluster count + centroid positions) so `clusterCount`/`clusters` come from the real RAPTOR tree instead of the node-type proxy; implement the `domainWarp` (sum of Gaussians at `warpSeeds`) in the shader's `escape()` (`c_warp = c + Σ amp·gaussian(c - seed)`); tune visually. Gate any >~32 seeds behind a texture rather than uniforms.
