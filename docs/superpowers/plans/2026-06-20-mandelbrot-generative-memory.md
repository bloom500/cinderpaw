# Mandelbrot Generative Memory — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Memory Layers Mandelbrot from a static backdrop into generative art that grows/recedes with memory + RSI state, with iridescent memory text woven along the fractal filaments and user-driven birth/extinction transitions.

**Architecture:** A pure `deriveFractalState()` maps `{nodeCount, rsi, persistedFloor}` → `{depthBoost, morph}`. A persisted monotonic `maturity` floor keeps earned depth. The WebGL2 shader gains `u_depthBoost`, `u_morph`, and zoom-adaptive `u_samples` (AA). A new `FilamentText` canvas layer replaces the orb `NodeOverlay`, drawing rotated iridescent text along filament tangents (computed by a shared CPU escape-time helper). A `useFractalTransition` hook eases state + birth/extinction over 1.5s on Refresh/Mount, then stops — no idle animation.

**Tech Stack:** React 18 + TypeScript, Vitest, WebGL2 (GLSL ES 3.0), Canvas 2D, Tauri IPC (`@/lib/tauri`). All work is **frontend-only** (no sidecar rebuild).

**Spec:** `docs/superpowers/specs/2026-06-20-mandelbrot-generative-memory-design.md`

## Global Constraints

- **No idle/auto animation.** Every animation is user-triggered (Mount/Refresh) and `cancelAnimationFrame`s itself when the ease completes. Idle = zero rAF loops.
- **Graceful RSI null:** `RsiStatus.engine` is `null` until the sidecar emits events. `morph = 0` and floor RSI-terms contribute `0` when `rsi == null` or `rsi.engine == null`. Never read `engine.iteration` without a guard.
- **Monotonic floor:** depth floor never decreases (persisted in `localStorage`); only the reactive term shrinks on prune.
- **`C_SEED = vec2(-0.8, 0.156)`** (thin-filament Julia seed) — verbatim in the shader.
- **`MORPH_MAX = 0.12`** — hard clamp on morph.
- **AA is zoom-adaptive:** 4 samples only when `view.scale > ZOOMOUT_AA_THRESHOLD` (0.05); 1 sample at deep zoom. Never run the iteration loop 4× unconditionally.
- **Test runner:** `cd frontend-react && npx vitest run <path>` (the `test` script is watch-mode; use `vitest run` in steps).
- **Don't touch zoom/pan logic** in `mandelbrot.ts` — it is already resolution-independent.
- Files live under `D:/FeralLocalAI/.worktrees/wt-29286b1b/frontend-react/` (worktree branch `feat/rsi-fractal-memory`). Paths below are repo-relative to `frontend-react/`.

---

## File Structure

- Create: `src/lib/fractal/escape.ts` — CPU smooth escape-time + filament tangent (shared math).
- Create: `src/lib/fractal/signal.ts` — `deriveFractalState` (pure mapping).
- Create: `src/lib/fractal/maturity.ts` — persisted monotonic floor store.
- Create: `src/lib/fractal/diff.ts` — pure node lifecycle diff.
- Create: `src/lib/fractal/useFractalTransition.ts` — rAF ease hook (state + phase).
- Create: `src/components/memory/FilamentText.tsx` — replaces `NodeOverlay`.
- Modify: `src/lib/fractal/mandelbrot.ts` — shader uniforms + adaptive AA + render signature.
- Modify: `src/components/memory/MandelbrotCanvas.tsx` — accept `fractalState` prop.
- Modify: `src/pages/MemoryLayersPage.tsx` — wire signal/maturity/transition; swap overlay.
- Delete (after swap): `src/components/memory/NodeOverlay.tsx`.
- Tests: `src/lib/fractal/__tests__/{escape,signal,maturity,diff}.test.ts`.

---

## Task 1: CPU escape-time + filament tangent (`escape.ts`)

**Files:**
- Create: `src/lib/fractal/escape.ts`
- Test: `src/lib/fractal/__tests__/escape.test.ts`

**Interfaces:**
- Produces:
  - `escapeTime(cx: number, cy: number, maxIter: number): number` — smooth iteration count; returns exactly `maxIter` for interior points.
  - `filamentTangent(cx: number, cy: number, maxIter: number, eps: number): { tx: number; ty: number }` — unit tangent of the escape-time level set (perpendicular to the gradient).

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/fractal/__tests__/escape.test.ts
import { describe, it, expect } from 'vitest';
import { escapeTime, filamentTangent } from '@/lib/fractal/escape';

describe('escapeTime', () => {
  it('returns maxIter for an interior point (origin is in the set)', () => {
    expect(escapeTime(0, 0, 256)).toBe(256);
  });
  it('returns a small smooth count for a fast-escaping point', () => {
    const t = escapeTime(2.0, 2.0, 256);
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThan(5);
  });
});

describe('filamentTangent', () => {
  it('returns a unit-length vector near the boundary', () => {
    const { tx, ty } = filamentTangent(-0.75, 0.1, 256, 1e-4);
    expect(Math.hypot(tx, ty)).toBeCloseTo(1, 6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend-react && npx vitest run src/lib/fractal/__tests__/escape.test.ts`
Expected: FAIL — cannot resolve `@/lib/fractal/escape`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/fractal/escape.ts
/**
 * CPU mirror of the shader's smooth-iteration Mandelbrot math, used by the
 * FilamentText layer to orient memory labels along the fractal's filaments.
 * Kept independent of WebGL so it is pure and unit-testable.
 */

const BAIL = 256.0;

/** Smooth (normalized) iteration count at complex point (cx,cy). Returns
 *  exactly `maxIter` when the point is interior (never escaped). */
export function escapeTime(cx: number, cy: number, maxIter: number): number {
  let zx = 0, zy = 0, i = 0;
  while (i < maxIter) {
    const nx = zx * zx - zy * zy + cx;
    const ny = 2 * zx * zy + cy;
    zx = nx; zy = ny;
    const mag2 = zx * zx + zy * zy;
    if (mag2 > BAIL) {
      // smooth: i + 1 - log2(log2|z|)
      const logZn = Math.log(mag2) / 2;
      const nu = Math.log(logZn / Math.LN2) / Math.LN2;
      return i + 1 - nu;
    }
    i++;
  }
  return maxIter;
}

/** Unit tangent of the escape-time level set at (cx,cy): perpendicular to the
 *  central-difference gradient. `eps` is the sampling step in complex units. */
export function filamentTangent(
  cx: number, cy: number, maxIter: number, eps: number,
): { tx: number; ty: number } {
  const gx = (escapeTime(cx + eps, cy, maxIter) - escapeTime(cx - eps, cy, maxIter)) / (2 * eps);
  const gy = (escapeTime(cx, cy + eps, maxIter) - escapeTime(cx, cy - eps, maxIter)) / (2 * eps);
  // tangent ⟂ gradient
  let tx = -gy, ty = gx;
  const len = Math.hypot(tx, ty) || 1;
  return { tx: tx / len, ty: ty / len };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend-react && npx vitest run src/lib/fractal/__tests__/escape.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend-react/src/lib/fractal/escape.ts frontend-react/src/lib/fractal/__tests__/escape.test.ts
git commit -m "feat(memory): CPU escape-time + filament tangent helper"
```

---

## Task 2: Pure signal mapping (`signal.ts`)

**Files:**
- Create: `src/lib/fractal/signal.ts`
- Test: `src/lib/fractal/__tests__/signal.test.ts`

**Interfaces:**
- Consumes: `RsiStatus` from `@/lib/tauri` (`{ engine: { iteration: number } | null, bounds_version: number | null, ... }`).
- Produces:
  - `interface FractalState { depthBoost: number; morph: number }`
  - `interface FractalSignalInput { nodeCount: number; rsi: RsiStatus | null; persistedFloor: number }`
  - `interface DerivedFractal { state: FractalState; floor: number }`
  - `function deriveFractalState(input: FractalSignalInput): DerivedFractal`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/fractal/__tests__/signal.test.ts
import { describe, it, expect } from 'vitest';
import { deriveFractalState } from '@/lib/fractal/signal';
import type { RsiStatus } from '@/lib/tauri';

const rsi = (iteration: number | null, boundsVersion: number | null): RsiStatus => ({
  initialized: true,
  bounds_sha256: null,
  bounds_version: boundsVersion,
  max_total_cost_usd: null,
  cost_warning_ratio: null,
  main_tip: null,
  main_tip_score: null,
  engine: iteration === null ? null : {
    running: true, iteration, best_score: null, cost_so_far_usd: 0,
    concurrency: 1, stop_reason: null,
  },
});

describe('deriveFractalState', () => {
  it('empty DB with zero floor → depthBoost 0, morph 0', () => {
    const { state } = deriveFractalState({ nodeCount: 0, rsi: null, persistedFloor: 0 });
    expect(state.depthBoost).toBe(0);
    expect(state.morph).toBe(0);
  });

  it('null engine → morph 0 (no crash)', () => {
    const { state } = deriveFractalState({ nodeCount: 100, rsi: rsi(null, 3), persistedFloor: 0 });
    expect(state.morph).toBe(0);
  });

  it('morph is clamped at 0.12', () => {
    const { state } = deriveFractalState({ nodeCount: 100, rsi: rsi(1_000_000, 0), persistedFloor: 0 });
    expect(state.morph).toBeLessThanOrEqual(0.12);
    expect(state.morph).toBeGreaterThan(0);
  });

  it('floor never decreases below persistedFloor', () => {
    const { floor } = deriveFractalState({ nodeCount: 0, rsi: rsi(0, 0), persistedFloor: 250 });
    expect(floor).toBeGreaterThanOrEqual(250);
  });

  it('a bounds_version bump raises the floor and it stays after a node drop', () => {
    const bumped = deriveFractalState({ nodeCount: 500, rsi: rsi(10, 5), persistedFloor: 0 });
    expect(bumped.floor).toBeGreaterThan(0);
    // later: nodes pruned to 0, engine reset to null — floor must persist via caller
    const after = deriveFractalState({ nodeCount: 0, rsi: null, persistedFloor: bumped.floor });
    expect(after.floor).toBe(bumped.floor);
    expect(after.state.depthBoost).toBeGreaterThanOrEqual(bumped.floor); // reactive=0, floor holds
  });

  it('reactive shrinks when nodeCount shrinks but total stays >= floor', () => {
    const many = deriveFractalState({ nodeCount: 10_000, rsi: null, persistedFloor: 100 });
    const few  = deriveFractalState({ nodeCount: 10,     rsi: null, persistedFloor: 100 });
    expect(few.state.depthBoost).toBeLessThan(many.state.depthBoost);
    expect(few.state.depthBoost).toBeGreaterThanOrEqual(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend-react && npx vitest run src/lib/fractal/__tests__/signal.test.ts`
Expected: FAIL — cannot resolve `@/lib/fractal/signal`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/fractal/signal.ts
import type { RsiStatus } from '@/lib/tauri';

/** Rendering parameters derived from memory + RSI state. */
export interface FractalState {
  /** Added to the zoom-driven iteration count (deeper structure). */
  depthBoost: number;
  /** Julia interpolation factor in [0, 0.12]. */
  morph: number;
}

export interface FractalSignalInput {
  /** Survivors in the current graph snapshot (already post-prune / "elite"). */
  nodeCount: number;
  /** RSI status; `null` (or `engine === null`) when the engine isn't wired. */
  rsi: RsiStatus | null;
  /** Current persisted monotonic floor (from the maturity store). */
  persistedFloor: number;
}

export interface DerivedFractal {
  state: FractalState;
  /** New monotonic floor to persist (>= persistedFloor). */
  floor: number;
}

// Tuning constants (see spec §Signal Mapping).
const MORPH_MAX = 0.12;
const REACTIVE_K = 18;        // depthBoost per log2 unit of living nodes
const FLOOR_ITER_A = 0.02;    // floor per RSI engine iteration (lifetime maturity)
const FLOOR_BOUNDS_B = 40;    // floor step per bounds_version (paradigm shift)
const MORPH_ITER_G = 0.0008;  // morph per RSI iteration (then clamped)

export function deriveFractalState(input: FractalSignalInput): DerivedFractal {
  const { nodeCount, rsi, persistedFloor } = input;
  const engine = rsi?.engine ?? null;
  const iter = engine?.iteration ?? 0;
  const boundsVersion = rsi?.bounds_version ?? 0;

  // Monotonic floor: max of what we've ever reached and this snapshot's candidate.
  const floorCandidate = FLOOR_ITER_A * iter + FLOOR_BOUNDS_B * boundsVersion;
  const floor = Math.max(persistedFloor, floorCandidate, 0);

  // Reactive "living volume": grows with nodes, retracts on prune. 0 for empty DB.
  const reactive = nodeCount <= 0 ? 0 : REACTIVE_K * Math.log2(1 + nodeCount);

  const depthBoost = Math.max(0, floor + reactive);
  const morph = engine === null ? 0 : Math.min(MORPH_MAX, Math.max(0, MORPH_ITER_G * iter));

  return { state: { depthBoost, morph }, floor };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend-react && npx vitest run src/lib/fractal/__tests__/signal.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend-react/src/lib/fractal/signal.ts frontend-react/src/lib/fractal/__tests__/signal.test.ts
git commit -m "feat(memory): pure deriveFractalState signal mapping"
```

---

## Task 3: Persisted monotonic maturity floor (`maturity.ts`)

**Files:**
- Create: `src/lib/fractal/maturity.ts`
- Test: `src/lib/fractal/__tests__/maturity.test.ts`

**Interfaces:**
- Produces:
  - `maturity.current(): number` — reads the persisted floor (0 if unset/unavailable).
  - `maturity.bump(value: number): number` — persists `max(current, value, 0)`, returns it.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/fractal/__tests__/maturity.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { maturity } from '@/lib/fractal/maturity';

beforeEach(() => localStorage.clear());

describe('maturity floor', () => {
  it('starts at 0 when unset', () => {
    expect(maturity.current()).toBe(0);
  });
  it('bump is max-only (never decreases)', () => {
    maturity.bump(300);
    expect(maturity.current()).toBe(300);
    maturity.bump(120);
    expect(maturity.current()).toBe(300);
    maturity.bump(450);
    expect(maturity.current()).toBe(450);
  });
  it('negative bumps are floored at the current value', () => {
    maturity.bump(100);
    expect(maturity.bump(-50)).toBe(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend-react && npx vitest run src/lib/fractal/__tests__/maturity.test.ts`
Expected: FAIL — cannot resolve `@/lib/fractal/maturity`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/fractal/maturity.ts
/**
 * Persisted monotonic "maturity floor" for the fractal's structural depth.
 * The floor only ever increases — earned complexity is never lost, even when
 * memory is pruned. Stored per-install in localStorage; degrades to 0 (no
 * persistence) if storage is unavailable, without throwing.
 */
const KEY = 'feral.fractal.maturityFloor';

export const maturity = {
  current(): number {
    try {
      const v = localStorage.getItem(KEY);
      const n = v == null ? 0 : parseFloat(v);
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  },
  bump(value: number): number {
    const next = Math.max(this.current(), value, 0);
    try {
      localStorage.setItem(KEY, String(next));
    } catch {
      /* storage unavailable — reactive-only depth this session */
    }
    return next;
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend-react && npx vitest run src/lib/fractal/__tests__/maturity.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend-react/src/lib/fractal/maturity.ts frontend-react/src/lib/fractal/__tests__/maturity.test.ts
git commit -m "feat(memory): persisted monotonic maturity floor"
```

---

## Task 4: Node lifecycle diff (`diff.ts`)

**Files:**
- Create: `src/lib/fractal/diff.ts`
- Test: `src/lib/fractal/__tests__/diff.test.ts`

**Interfaces:**
- Produces:
  - `interface NodeDiff { born: Set<string>; extinct: Set<string>; surviving: Set<string>; changed: boolean }`
  - `function diffNodes(prevIds: Iterable<string>, nextIds: Iterable<string>): NodeDiff`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/fractal/__tests__/diff.test.ts
import { describe, it, expect } from 'vitest';
import { diffNodes } from '@/lib/fractal/diff';

describe('diffNodes', () => {
  it('classifies born / extinct / surviving', () => {
    const d = diffNodes(['a', 'b', 'c'], ['b', 'c', 'd']);
    expect([...d.born]).toEqual(['d']);
    expect([...d.extinct]).toEqual(['a']);
    expect([...d.surviving].sort()).toEqual(['b', 'c']);
    expect(d.changed).toBe(true);
  });
  it('changed is false for identical sets', () => {
    const d = diffNodes(['a', 'b'], ['b', 'a']);
    expect(d.changed).toBe(false);
    expect(d.born.size).toBe(0);
    expect(d.extinct.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend-react && npx vitest run src/lib/fractal/__tests__/diff.test.ts`
Expected: FAIL — cannot resolve `@/lib/fractal/diff`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/fractal/diff.ts
/** Pure prev→next node-id diff driving birth/extinction transitions. */
export interface NodeDiff {
  born: Set<string>;       // in next, not in prev
  extinct: Set<string>;    // in prev, not in next
  surviving: Set<string>;  // in both
  changed: boolean;        // any birth or extinction
}

export function diffNodes(prevIds: Iterable<string>, nextIds: Iterable<string>): NodeDiff {
  const prev = new Set(prevIds);
  const next = new Set(nextIds);
  const born = new Set<string>();
  const extinct = new Set<string>();
  const surviving = new Set<string>();
  for (const id of next) (prev.has(id) ? surviving : born).add(id);
  for (const id of prev) if (!next.has(id)) extinct.add(id);
  return { born, extinct, surviving, changed: born.size > 0 || extinct.size > 0 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend-react && npx vitest run src/lib/fractal/__tests__/diff.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend-react/src/lib/fractal/diff.ts frontend-react/src/lib/fractal/__tests__/diff.test.ts
git commit -m "feat(memory): pure node lifecycle diff"
```

---

## Task 5: Shader growth + morph + adaptive AA (`mandelbrot.ts`)

**Files:**
- Modify: `src/lib/fractal/mandelbrot.ts`

**Interfaces:**
- Consumes: `FractalState` from `@/lib/fractal/signal`.
- Produces: `MandelbrotRenderer.render(view: View, theme: FractalTheme, fractal?: FractalState): void` (new optional 3rd arg; absent → `depthBoost 0, morph 0`).

- [ ] **Step 1: Replace the fragment shader (`FRAG`) with the morph + supersampling version**

Replace the entire `const FRAG = ...` template (currently `mandelbrot.ts:49-104`) with:

```ts
// Smooth-iteration Mandelbrot with subtle Julia morph + zoom-adaptive AA.
const FRAG = `#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2  u_res;        // canvas pixels
uniform vec2  u_center;     // complex center
uniform float u_scale;      // complex units per half-height
uniform int   u_theme;      // 0 light, 1 dark
uniform int   u_maxIter;
uniform float u_morph;      // 0..0.12 Julia interpolation
uniform int   u_samples;    // 1 or 4 (zoom-adaptive AA)

const vec2 C_SEED = vec2(-0.8, 0.156); // thin-filament Julia seed

vec3 lightPalette(float t) {
  vec3 field  = vec3(0.918, 0.910, 0.949);
  vec3 violet = vec3(0.357, 0.373, 0.682);
  vec3 peri   = vec3(0.604, 0.627, 0.878);
  vec3 c = mix(field, peri, smoothstep(0.0, 0.5, t));
  c = mix(c, violet, smoothstep(0.4, 1.0, t));
  return c;
}
vec3 darkPalette(float t) {
  vec3 red    = vec3(0.45, 0.06, 0.03);
  vec3 orange = vec3(0.92, 0.45, 0.06);
  vec3 amber  = vec3(1.00, 0.72, 0.25);
  vec3 cream  = vec3(1.00, 0.96, 0.86);
  vec3 c = mix(red, orange, smoothstep(0.0, 0.45, t));
  c = mix(c, amber, smoothstep(0.4, 0.8, t));
  c = mix(c, cream, smoothstep(0.85, 1.0, t));
  return c;
}

// Smooth iteration at complex point c. Returns -1.0 for interior.
float escape(vec2 c) {
  vec2 ceff = mix(c, C_SEED, u_morph);
  vec2 z = vec2(0.0);
  int i = 0;
  const float BAIL = 256.0;
  for (int n = 0; n < 2048; n++) {
    if (n >= u_maxIter) break;
    z = vec2(z.x*z.x - z.y*z.y, 2.0*z.x*z.y) + ceff;
    if (dot(z, z) > BAIL) break;
    i++;
  }
  if (i >= u_maxIter) return -1.0;
  float mu = float(i) + 1.0 - log2(log2(dot(z, z)) * 0.5);
  return clamp(mu / float(u_maxIter), 0.0, 1.0);
}

vec3 shade(float t) {
  if (t < 0.0) return (u_theme == 1) ? vec3(0.02, 0.02, 0.03) : vec3(0.05, 0.05, 0.09);
  float tt = pow(t, 0.5);
  return (u_theme == 1) ? darkPalette(tt) : lightPalette(tt);
}

void main() {
  float aspect = u_res.x / u_res.y;
  vec3 acc = vec3(0.0);
  // u_samples == 1 → one center sample (deep zoom, cheap). == 4 → 2x2 grid.
  for (int sy = 0; sy < 2; sy++) {
    for (int sx = 0; sx < 2; sx++) {
      if (u_samples == 1 && (sx != 0 || sy != 0)) continue;
      vec2 off = (u_samples == 1) ? vec2(0.0)
                                  : (vec2(float(sx), float(sy)) - 0.5) * 0.5;
      vec2 ndc = ((gl_FragCoord.xy + off) / u_res) * 2.0 - 1.0;
      vec2 c = u_center + vec2(ndc.x * u_scale * aspect, ndc.y * u_scale);
      acc += shade(escape(c));
    }
  }
  float div = (u_samples == 1) ? 1.0 : 4.0;
  outColor = vec4(acc / div, 1.0);
}`;
```

- [ ] **Step 2: Add the new uniform locations**

In `createMandelbrotRenderer`, after `const u_maxIter = gl.getUniformLocation(prog, 'u_maxIter');` (currently `mandelbrot.ts:155`), add:

```ts
  const u_morph = gl.getUniformLocation(prog, 'u_morph');
  const u_samples = gl.getUniformLocation(prog, 'u_samples');
```

- [ ] **Step 3: Update the `render` signature + body**

Replace the `render` function (currently `mandelbrot.ts:167-178`) with:

```ts
  const ZOOMOUT_AA_THRESHOLD = 0.05; // supersample only when zoomed out

  const render = (view: View, theme: FractalTheme, fractal?: FractalState) => {
    resize();
    gl.useProgram(prog);
    gl.uniform2f(u_res, canvas.width, canvas.height);
    gl.uniform2f(u_center, view.centerX, view.centerY);
    gl.uniform1f(u_scale, view.scale);
    gl.uniform1i(u_theme, theme === 'dark' ? 1 : 0);
    // Zoom-driven base iterations + memory-driven depth boost, capped by loop.
    const base = Math.floor(120 + 60 * Math.log2(1 / Math.max(view.scale, 1e-7)));
    const boost = Math.max(0, Math.floor(fractal?.depthBoost ?? 0));
    const iter = Math.min(2048, Math.max(120, base + boost));
    gl.uniform1i(u_maxIter, iter);
    gl.uniform1f(u_morph, fractal?.morph ?? 0);
    // Adaptive AA: 4 samples when zoomed out (maxIter is low there, so cheap);
    // 1 sample at deep zoom (aliasing negligible, loop is expensive).
    gl.uniform1i(u_samples, view.scale > ZOOMOUT_AA_THRESHOLD ? 4 : 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
```

- [ ] **Step 4: Update the `MandelbrotRenderer` interface + import**

At the top of the file add the import:

```ts
import type { FractalState } from '@/lib/fractal/signal';
```

Change the interface (currently `mandelbrot.ts:119-123`) `render` line to:

```ts
  render(view: View, theme: FractalTheme, fractal?: FractalState): void;
```

- [ ] **Step 5: Verify typecheck + existing projection tests still pass**

Run: `cd frontend-react && npx tsc --noEmit && npx vitest run src/lib/fractal/__tests__/mandelbrot.test.ts`
Expected: tsc clean; PASS (3 existing projection tests — they don't touch rendering).

- [ ] **Step 6: Commit**

```bash
git add frontend-react/src/lib/fractal/mandelbrot.ts
git commit -m "feat(memory): shader depth boost, Julia morph, zoom-adaptive AA"
```

---

## Task 6: Pass `fractalState` through `MandelbrotCanvas`

**Files:**
- Modify: `src/components/memory/MandelbrotCanvas.tsx`

**Interfaces:**
- Consumes: `FractalState` from `@/lib/fractal/signal`; `MandelbrotRenderer.render(view, theme, fractal?)` from Task 5.
- Produces: `<MandelbrotCanvas view theme fractalState onViewChange />` — new required `fractalState: FractalState` prop, forwarded to every `render` call.

- [ ] **Step 1: Add the prop and forward it to all render calls**

Add to the imports:

```ts
import type { FractalState } from '@/lib/fractal/signal';
```

In `interface Props`, add:

```ts
  /** Memory/RSI-derived rendering parameters (depth + morph). */
  fractalState: FractalState;
```

Update the function signature destructure to include `fractalState`:

```ts
export function MandelbrotCanvas({ view, theme, fractalState, onViewChange }: Props) {
```

Add a ref that always holds the latest state (so the resize handler and the
create-once effect read current values without re-subscribing):

```ts
  const fractalRef = useRef(fractalState);
  fractalRef.current = fractalState;
```

In the create-once effect, change the resize handler to forward the state:

```ts
    const onResize = () => { r.render(viewRef.current, theme, fractalRef.current); };
```

Replace the redraw effect (currently lines 47-49) with one that also redraws on
`fractalState` change:

```ts
  // Redraw on view/theme/fractalState change.
  useEffect(() => {
    rendererRef.current?.render(view, theme, fractalState);
  }, [view, theme, fractalState]);
```

- [ ] **Step 2: Verify typecheck**

Run: `cd frontend-react && npx tsc --noEmit`
Expected: FAILS only in `MemoryLayersPage.tsx` (missing `fractalState` prop) — that is fixed in Task 9. `MandelbrotCanvas.tsx` itself must be error-free. If any other file errors, fix here.

> Note: this task leaves the page temporarily un-typechecked; it is completed by Task 9. Commit anyway — the unit of work (canvas accepts state) is self-contained.

- [ ] **Step 3: Commit**

```bash
git add frontend-react/src/components/memory/MandelbrotCanvas.tsx
git commit -m "feat(memory): MandelbrotCanvas forwards fractalState to the renderer"
```

---

## Task 7: FilamentText layer (replaces NodeOverlay)

**Files:**
- Create: `src/components/memory/FilamentText.tsx`
- Test: (none — canvas drawing; the testable math lives in `escape.ts`/`diff.ts`, already covered. Verified visually in Task 9 review.)

**Interfaces:**
- Consumes: `layoutNodes`, `LaidOutNode` from `@/lib/fractal/layout`; `complexToScreen`, `View` from `@/lib/fractal/mandelbrot`; `filamentTangent` from `@/lib/fractal/escape`; `MemoryGraphSnapshot` from `@/lib/tauri`; `NodeDiff` from `@/lib/fractal/diff`.
- Produces: `<FilamentText snapshot view colorFor hiddenTypes search showLabels diff phase departing onSelect />`
  - `phase: number` (0..1) — transition progress; `1` when idle (fully settled).
  - `departing: LaidOutNode[]` — extinct nodes from the previous snapshot, rendered fading out during a transition.
  - `diff: NodeDiff` — to know which current nodes are `born` (fade/draw-in).

- [ ] **Step 1: Create the component**

```tsx
// src/components/memory/FilamentText.tsx
import { useEffect, useMemo, useRef } from 'react';
import type { MemoryGraphSnapshot } from '@/lib/tauri';
import { complexToScreen, type View } from '@/lib/fractal/mandelbrot';
import { layoutNodes, type LaidOutNode } from '@/lib/fractal/layout';
import { filamentTangent } from '@/lib/fractal/escape';
import type { NodeDiff } from '@/lib/fractal/diff';

interface Props {
  snapshot: MemoryGraphSnapshot;
  view: View;
  colorFor: (type: string) => string;
  hiddenTypes: Set<string>;
  search: string;
  showLabels?: boolean;
  /** Transition progress 0..1; 1 = settled/idle. */
  phase: number;
  /** Extinct nodes (from the previous snapshot) fading out this transition. */
  departing: LaidOutNode[];
  /** Birth/extinction classification for the current snapshot. */
  diff: NodeDiff;
  onSelect: (id: string | null) => void;
}

const HIT_PX = 14;
const MAX_DRAWN = 4000;            // hard cap (100k-node safety)
const TEXT_SCALE_MAX = 0.12;       // show filament text only when zoomed in past this
const SPARK_RADIUS = 2.5;          // discrete dot when zoomed out / dense

/** Iteration budget for tangent sampling — coarse is fine for orientation. */
const TANGENT_ITER = 200;

/** Iridescent per-character hue: shift the node's base color along the palette. */
function iridescent(base: string, charIndex: number, alpha: number): string {
  // base is "#rrggbb"; rotate lightly by character to get the shimmer.
  const n = base.startsWith('#') ? parseInt(base.slice(1), 16) : 0x888888;
  let r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
  const shimmer = Math.sin(charIndex * 0.6) * 28;
  r = Math.max(0, Math.min(255, r + shimmer));
  b = Math.max(0, Math.min(255, b - shimmer));
  return `rgba(${r | 0},${g | 0},${b | 0},${alpha})`;
}

/** Draw a string along a tangent direction, one rotated glyph at a time. */
function drawAlong(
  ctx: CanvasRenderingContext2D,
  text: string, px: number, py: number, tx: number, ty: number,
  baseColor: string, alpha: number, reveal: number,
) {
  const angle = Math.atan2(ty, tx);
  const step = 7; // px between glyph centers
  const count = Math.max(1, Math.ceil(text.length * reveal));
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(angle);
  ctx.font = '11px Inter, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.shadowBlur = 6;
  for (let i = 0; i < count && i < text.length; i++) {
    const color = iridescent(baseColor, i, alpha);
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.fillText(text[i], (i - text.length / 2) * step, 0);
  }
  ctx.restore();
}

export function FilamentText({
  snapshot, view, colorFor, hiddenTypes, search, showLabels = true,
  phase, departing, diff, onSelect,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const laidOut = useMemo(() => layoutNodes(snapshot), [snapshot]);
  const q = search.trim().toLowerCase();
  const visible = useMemo<LaidOutNode[]>(
    () => laidOut
      .filter((n) => !hiddenTypes.has(n.type) && (!q || n.label.toLowerCase().includes(q)))
      .sort((a, b) => b.degree - a.degree),
    [laidOut, hiddenTypes, q],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // eps for tangent sampling: ~1.5 device-independent px in complex units.
    const eps = (view.scale * 2) / h * 1.5;
    const asText = showLabels && view.scale < TEXT_SCALE_MAX;

    const paint = (n: LaidOutNode, alpha: number, reveal: number) => {
      const p = complexToScreen(n.wx, n.wy, w, h, view);
      if (p.px < -60 || p.py < -60 || p.px > w + 60 || p.py > h + 60) return;
      const color = colorFor(n.type);
      if (asText) {
        const { tx, ty } = filamentTangent(n.wx, n.wy, TANGENT_ITER, eps);
        drawAlong(ctx, n.label, p.px, p.py, tx, ty, color, alpha, reveal);
      } else {
        ctx.fillStyle = color;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.arc(p.px, p.py, SPARK_RADIUS, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    };

    let drawn = 0;
    // Current nodes: born nodes fade/draw in with `phase`; survivors are full.
    for (const n of visible) {
      if (drawn >= MAX_DRAWN) break;
      const born = diff.born.has(n.id);
      paint(n, born ? phase : 1, born ? phase : 1);
      drawn++;
    }
    // Departing (extinct) nodes from the previous snapshot fade/erase out.
    for (const n of departing) {
      if (drawn >= MAX_DRAWN) break;
      if (hiddenTypes.has(n.type)) continue;
      paint(n, 1 - phase, 1 - phase);
      drawn++;
    }
  }, [visible, departing, diff, view, phase, colorFor, hiddenTypes, showLabels]);

  const onClick = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    let best: { id: string; d: number } | null = null;
    for (const n of visible) {
      const p = complexToScreen(n.wx, n.wy, rect.width, rect.height, view);
      const d = Math.hypot(p.px - px, p.py - py);
      if (d <= HIT_PX && (!best || d < best.d)) best = { id: n.id, d };
    }
    onSelect(best?.id ?? null);
  };

  return (
    <canvas
      ref={canvasRef}
      onClick={onClick}
      className="pointer-events-none fixed inset-0 z-[1] h-full w-full"
    />
  );
}
```

- [ ] **Step 2: Verify typecheck (component in isolation)**

Run: `cd frontend-react && npx tsc --noEmit`
Expected: no NEW errors in `FilamentText.tsx` (page still errors until Task 9). If `FilamentText.tsx` itself errors, fix here.

- [ ] **Step 3: Commit**

```bash
git add frontend-react/src/components/memory/FilamentText.tsx
git commit -m "feat(memory): FilamentText layer — iridescent text along filaments + birth/extinction"
```

---

## Task 8: Transition hook (`useFractalTransition.ts`)

**Files:**
- Create: `src/lib/fractal/useFractalTransition.ts`

**Interfaces:**
- Consumes: `FractalState` from `@/lib/fractal/signal`.
- Produces:
  - `function useFractalTransition(): { displayed: FractalState; phase: number; run: (from: FractalState, to: FractalState, animate: boolean) => void }`
  - `displayed` eases `from → to`; `phase` goes `0 → 1` over 1.5s ease-out; both settle at `to`/`1`. When `animate === false`, snaps instantly. Auto-cancels any prior rAF.

- [ ] **Step 1: Create the hook**

```ts
// src/lib/fractal/useFractalTransition.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FractalState } from '@/lib/fractal/signal';

const DURATION_MS = 1500;
const easeOut = (p: number) => 1 - Math.pow(1 - p, 3); // cubic ease-out

const ZERO: FractalState = { depthBoost: 0, morph: 0 };

/**
 * Drives a one-shot, user-triggered ease of the fractal state + a 0→1 `phase`
 * for birth/extinction. No idle loop: the rAF cancels itself when the ease
 * completes, and a new `run()` cancels any in-flight ease first.
 */
export function useFractalTransition() {
  const [displayed, setDisplayed] = useState<FractalState>(ZERO);
  const [phase, setPhase] = useState(1);
  const rafRef = useRef<number | null>(null);

  const cancel = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  const run = useCallback((from: FractalState, to: FractalState, animate: boolean) => {
    cancel();
    if (!animate) {
      setDisplayed(to);
      setPhase(1);
      return;
    }
    const start = performance.now();
    setPhase(0);
    const tick = (now: number) => {
      const raw = Math.min(1, (now - start) / DURATION_MS);
      const e = easeOut(raw);
      setDisplayed({
        depthBoost: from.depthBoost + (to.depthBoost - from.depthBoost) * e,
        morph: from.morph + (to.morph - from.morph) * e,
      });
      setPhase(e);
      if (raw < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null; // settle — no idle loop
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  useEffect(() => cancel, []); // cleanup on unmount

  return { displayed, phase, run };
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd frontend-react && npx tsc --noEmit`
Expected: no new errors in `useFractalTransition.ts` (page still errors until Task 9).

- [ ] **Step 3: Commit**

```bash
git add frontend-react/src/lib/fractal/useFractalTransition.ts
git commit -m "feat(memory): user-driven fractal transition hook (1.5s ease-out, auto-stop)"
```

---

## Task 9: Wire it into MemoryLayersPage + swap overlay

**Files:**
- Modify: `src/pages/MemoryLayersPage.tsx`
- Delete: `src/components/memory/NodeOverlay.tsx`

**Interfaces:**
- Consumes: everything from Tasks 2–8 (`deriveFractalState`, `maturity`, `diffNodes`, `useFractalTransition`, `FilamentText`, `MandelbrotCanvas` w/ `fractalState`).

- [ ] **Step 1: Add imports**

Add near the existing fractal imports:

```ts
import { FilamentText } from '@/components/memory/FilamentText';
import { deriveFractalState, type FractalState } from '@/lib/fractal/signal';
import { maturity } from '@/lib/fractal/maturity';
import { diffNodes, type NodeDiff } from '@/lib/fractal/diff';
import { useFractalTransition } from '@/lib/fractal/useFractalTransition';
import type { LaidOutNode } from '@/lib/fractal/layout';
import type { RsiStatus } from '@/lib/tauri';
```

Remove the `NodeOverlay` import.

- [ ] **Step 2: Add transition + lifecycle state and a target derivation**

Inside `MemoryLayersPage`, after the existing `const [view, setView] = useState<View>(SEAHORSE_VIEW);` line, add:

```ts
  const { displayed: fractalState, phase, run } = useFractalTransition();
  const [diff, setDiff] = useState<NodeDiff>({
    born: new Set(), extinct: new Set(), surviving: new Set(), changed: false,
  });
  const [departing, setDeparting] = useState<LaidOutNode[]>([]);
  const prevTargetRef = useRef<FractalState>({ depthBoost: 0, morph: 0 });
  const prevIdsRef = useRef<string[]>([]);
  const prevLaidOutRef = useRef<LaidOutNode[]>([]);
```

- [ ] **Step 3: Drive the transition when a graph snapshot arrives**

Replace the existing `load` function body's `try` block so that after the graph
is fetched it also pulls RSI status, derives the target, persists the floor,
diffs lifecycle, and runs the transition. Replace the whole `load` function
(currently lines 42-52) with:

```ts
  const applySnapshot = (next: MemoryGraphSnapshot, rsi: RsiStatus | null, animate: boolean) => {
    const persisted = maturity.current();
    const { state: target, floor } = deriveFractalState({
      nodeCount: next.nodes.length, rsi, persistedFloor: persisted,
    });
    maturity.bump(floor);

    const nextIds = next.nodes.map((n) => n.id);
    const d = diffNodes(prevIdsRef.current, nextIds);
    setDiff(d);
    // Departing nodes are laid out from the PREVIOUS snapshot so they fade from
    // where they lived. We reuse the previous laid-out array, filtered to extinct.
    setDeparting(prevLaidOutRef.current.filter((n) => d.extinct.has(n.id)));

    run(prevTargetRef.current, target, animate && (d.changed || target.depthBoost !== prevTargetRef.current.depthBoost || target.morph !== prevTargetRef.current.morph));

    prevTargetRef.current = target;
    prevIdsRef.current = nextIds;
    prevLaidOutRef.current = layoutNodes(next);
  };

  const load = async (animate = true) => {
    setLoading(true);
    setSelected(null);
    try {
      const [next, rsi] = await Promise.all([
        tauri.memory.getGraph(),
        tauri.rsi.status().catch(() => null), // engine null / not wired → graceful
      ]);
      setGraph(next);
      applySnapshot(next, rsi, animate);
    } catch {
      setGraph({ nodes: [], edges: [] });
    } finally {
      setLoading(false);
    }
  };
```

> The first `load()` on mount passes `animate = true` from a zero baseline, so a
> brand-new install eases from the smooth disc into its initial structure.

- [ ] **Step 4: Pass `fractalState` to the canvas and swap `NodeOverlay` → `FilamentText`**

In the scene JSX (currently lines 270-301), update the canvas call:

```tsx
          <MandelbrotCanvas view={view} theme={fractalTheme} fractalState={fractalState} onViewChange={setView} />
```

Replace the `<NodeOverlay ... />` element with:

```tsx
          <FilamentText
            snapshot={graph}
            view={view}
            colorFor={colorFor}
            hiddenTypes={hiddenTypes}
            search={search}
            showLabels={showLabels}
            phase={phase}
            departing={departing}
            diff={diff}
            onSelect={(id) => {
              if (!id) { setSelected(null); return; }
              const node = graph.nodes.find((n) => n.id === id);
              if (!node) return;
              const neighbors: SelectedNode['neighbors'] = [];
              for (const e of graph.edges) {
                if (e.from === id) {
                  const to = graph.nodes.find((n) => n.id === e.to);
                  if (to) neighbors.push({ relation: e.relation, label: to.label, direction: 'out' });
                } else if (e.to === id) {
                  const from = graph.nodes.find((n) => n.id === e.from);
                  if (from) neighbors.push({ relation: e.relation, label: from.label, direction: 'in' });
                }
              }
              setSelected({ id: node.id, label: node.label, type: node.type, neighbors });
            }}
          />
```

- [ ] **Step 5: Delete the obsolete NodeOverlay**

```bash
git rm frontend-react/src/components/memory/NodeOverlay.tsx
```

- [ ] **Step 6: Verify full typecheck + entire fractal test suite**

Run: `cd frontend-react && npx tsc --noEmit && npx vitest run src/lib/fractal`
Expected: tsc clean (no remaining `fractalState`/import errors); all fractal tests PASS (escape, signal, maturity, diff, mandelbrot, layout).

- [ ] **Step 7: Commit**

```bash
git add frontend-react/src/pages/MemoryLayersPage.tsx frontend-react/src/components/memory/NodeOverlay.tsx
git commit -m "feat(memory): wire generative fractal — signal, maturity, lifecycle transitions; swap orbs for filament text"
```

---

## Task 10: Visual verification + lint pass

**Files:** none (verification only).

- [ ] **Step 1: Typecheck + lint the whole frontend**

Run: `cd frontend-react && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 2: Run the full frontend test suite once**

Run: `cd frontend-react && npx vitest run`
Expected: all green (new + pre-existing).

- [ ] **Step 3: Launch the app and verify the three lifecycle states**

Run the app per project convention (`cargo tauri dev` from `src-tauri`, or the
project's run skill). Open **Memory Layers** and confirm:
- **Tabula Rasa:** with an empty/near-empty graph, the fractal is a smooth disc (low detail), no text.
- **Genesis:** after memories exist, filaments are deeper and memory labels render *along* the filament curves with iridescence (not floating orbs); zoom-out shows discrete sparks (LOD); the earlier salt-and-pepper speckle at zoom-out is gone (adaptive AA).
- **Cataclysm:** hit **Refresh** after the node count drops (e.g., prune); extinct labels fade/erase out along their curves while structure eases to a simpler, airier form — over ~1.5s, then fully still (no idle animation).
- Zoom/pan still smooth and non-pixelated at depth.

- [ ] **Step 4: Commit any fixes found during visual verification**

```bash
git add -A
git commit -m "fix(memory): visual-verification adjustments for generative fractal"
```

(Skip if no changes were needed.)

---

## Self-Review Notes (author check — already applied)

- **Spec coverage:** Tabula Rasa/Genesis/Cataclysm → Tasks 5–9 + Task 10 verification. Growth (depthBoost) → Tasks 2,5. Morph + `C_SEED` + null-guard → Tasks 2,5. Adaptive AA → Task 5. Filament text + iridescence + LOD → Task 7. Birth/extinction + prev-snapshot rendering → Tasks 4,7,9. Hybrid floor + `bounds_version` + persistence → Tasks 2,3. 1.5s ease-out, user-driven, auto-stop → Task 8. Phase B → out of scope (spec §Future), no task.
- **Graceful null:** `tauri.rsi.status().catch(() => null)` (Task 9) + `engine === null → morph 0` (Task 2).
- **Type consistency:** `FractalState {depthBoost, morph}`, `render(view, theme, fractal?)`, `useFractalTransition().run(from, to, animate)`, `NodeDiff {born, extinct, surviving, changed}`, `FilamentText` props all match across tasks.
