# Mandelbrot Organism Bulletproof — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Memory Layers Mandelbrot organism visibly evolve from real RAPTOR cluster data (not the node-type proxy), with smooth eased growth, domain-warp rendering, and WebGL crash-robustness.

**Architecture:** Sidecar (TS) projects 384-dim RAPTOR cluster centroids to 2D and ships them in the `grow` event. The frontend derives a coarse power signal (rest only at 2 or ≥4.5) plus warp seeds from those positions, eases between states via the existing impulse hook, and a new GLSL domain-warp bends the Mandelbrot boundary outward at dense clusters. WebGL context-loss is recovered instead of going permanently black.

**Tech Stack:** Bun + TypeScript (sidecar, `bun:test`); React + Vite + WebGL2 (frontend, `vitest`).

## Global Constraints

- Sidecar tests run with `bun test` from `FeralAgent/`. Frontend tests run with `npx vitest run` from `frontend-react/`.
- TS path alias `@/` → `frontend-react/src/`.
- No Rust changes: the `feral://agent-output` event is forwarded verbatim, so new JSON fields pass through untouched.
- Preserve the "no idle animation" invariant: every `requestAnimationFrame` loop must self-terminate and be cancelled on unmount; GPU returns to 0% at rest.
- Power must NEVER come to REST in the open interval (2, 4.5). Genesis (new user / ≤2 clusters) = exactly 2.0. Cap = 5.0.
- Sidecar TS change requires `bun run build` + copy to `src-tauri/binaries/feral-agent-x86_64-pc-windows-msvc.exe` to take effect in the app (not needed for `bun test`).

---

### Task 1: `projectCentroids` — 384-dim → 2D layout (sidecar)

**Files:**
- Create: `FeralAgent/src/memory/fractal/project-centroids.ts`
- Test: `FeralAgent/tests/fractal-project-centroids.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface Point2D { x: number; y: number }` and
  `function projectCentroids(centroids: Float32Array[], seed?: number): Point2D[]`.
  Deterministic for a given seed. `[]` → `[]`. Output points lie within the
  complex band `x ∈ [-2, 0.6]`, `y ∈ [-1.2, 1.2]`.

- [ ] **Step 1: Write the failing test**

```ts
// FeralAgent/tests/fractal-project-centroids.test.ts
import { describe, it, expect } from "bun:test";
import { projectCentroids } from "../src/memory/fractal/project-centroids.ts";

const vec = (xs: number[]) => Float32Array.from(xs);

describe("projectCentroids", () => {
  it("empty input → empty output", () => {
    expect(projectCentroids([])).toEqual([]);
  });

  it("is deterministic for a fixed seed", () => {
    const cs = [vec([1, 0, 0, 2]), vec([0, 1, 3, 0]), vec([2, 2, 1, 1])];
    expect(projectCentroids(cs, 7)).toEqual(projectCentroids(cs, 7));
  });

  it("keeps every point inside the Mandelbrot band", () => {
    const cs = Array.from({ length: 20 }, (_, i) =>
      vec([Math.sin(i), Math.cos(i), i % 3, (i * 7) % 5]));
    for (const p of projectCentroids(cs, 1)) {
      expect(p.x).toBeGreaterThanOrEqual(-2);
      expect(p.x).toBeLessThanOrEqual(0.6);
      expect(p.y).toBeGreaterThanOrEqual(-1.2);
      expect(p.y).toBeLessThanOrEqual(1.2);
    }
  });

  it("maps distinct centroids to distinct positions", () => {
    const cs = [vec([5, 0, 0, 0]), vec([0, 5, 0, 0]), vec([0, 0, 5, 0])];
    const ps = projectCentroids(cs, 1);
    expect(new Set(ps.map((p) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`)).size).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd FeralAgent && bun test tests/fractal-project-centroids.test.ts`
Expected: FAIL — `Cannot find module '../src/memory/fractal/project-centroids.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// FeralAgent/src/memory/fractal/project-centroids.ts
/**
 * Project L2-normalized RAPTOR cluster centroids (384-dim) down to 2D points
 * laid out across the Mandelbrot boundary band, for use as domain-warp seeds.
 *
 * Random projection (Johnson–Lindenstrauss): two fixed seeded Gaussian vectors
 * give a stable, O(n·dim) layout that keeps distinct topics at distinct, stable
 * positions. Not a metric embedding — a believable organic layout is the goal.
 */
export interface Point2D { x: number; y: number }

/** mulberry32 — same PRNG family used elsewhere in the fractal code. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard-normal sample via Box–Muller from a uniform PRNG. */
function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const X_LO = -2, X_HI = 0.6, Y_LO = -1.2, Y_HI = 1.2;

function rescale(vals: number[], lo: number, hi: number): number[] {
  let min = Infinity, max = -Infinity;
  for (const v of vals) { if (v < min) min = v; if (v > max) max = v; }
  const span = max - min;
  if (!Number.isFinite(span) || span < 1e-9) {
    const mid = (lo + hi) / 2;
    return vals.map(() => mid);
  }
  return vals.map((v) => lo + ((v - min) / span) * (hi - lo));
}

export function projectCentroids(centroids: Float32Array[], seed = 1): Point2D[] {
  if (centroids.length === 0) return [];
  const dim = centroids[0]!.length;
  const rand = mulberry32(seed);
  const ax = Array.from({ length: dim }, () => gaussian(rand));
  const ay = Array.from({ length: dim }, () => gaussian(rand));
  const rawX: number[] = [];
  const rawY: number[] = [];
  for (const c of centroids) {
    let x = 0, y = 0;
    for (let i = 0; i < dim; i++) { x += c[i]! * ax[i]!; y += c[i]! * ay[i]!; }
    rawX.push(x); rawY.push(y);
  }
  const sx = rescale(rawX, X_LO, X_HI);
  const sy = rescale(rawY, Y_LO, Y_HI);
  return sx.map((x, i) => ({ x, y: sy[i]! }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd FeralAgent && bun test tests/fractal-project-centroids.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add FeralAgent/src/memory/fractal/project-centroids.ts FeralAgent/tests/fractal-project-centroids.test.ts
git commit -m "feat(fractal): projectCentroids — 384d cluster centroids to 2D warp layout"
```

---

### Task 2: `grow` event carries projected cluster positions (sidecar)

**Files:**
- Modify: `FeralAgent/src/memory/fractal/fractal-memory.ts` (type `FractalActivity` ~line 70-72; `#doRebuild` emit ~line 261)
- Test: `FeralAgent/tests/fractal-memory-activity.test.ts`

**Interfaces:**
- Consumes: `projectCentroids` + `Point2D` from Task 1.
- Produces: the `grow` variant of `FractalActivity` becomes
  `{ kind: "grow"; leafCount: number; clusterCount: number; clusters: { x: number; y: number; weight: number }[] }`.
  `weight` is the cluster's `leafIds.length` normalized to `0..1` across the
  top-level clusters (max weight = 1).

- [ ] **Step 1: Write the failing test**

```ts
// FeralAgent/tests/fractal-memory-activity.test.ts — ADD this test
// (keep existing tests in the file). Import projectCentroids-free: assert shape.
import { describe, it, expect } from "bun:test";
import { buildGrowActivity } from "../src/memory/fractal/fractal-memory.ts";

describe("buildGrowActivity", () => {
  it("emits normalized weights and one cluster point per top-level child", () => {
    const tree = {
      leafIds: [1, 2, 3, 4, 5],
      children: [
        { leafIds: [1, 2, 3], centroid: Float32Array.from([1, 0, 0]) },
        { leafIds: [4, 5], centroid: Float32Array.from([0, 1, 0]) },
      ],
    } as any;
    const a = buildGrowActivity(tree);
    expect(a.kind).toBe("grow");
    expect(a.leafCount).toBe(5);
    expect(a.clusterCount).toBe(2);
    expect(a.clusters).toHaveLength(2);
    // max leaf count (3) normalizes to weight 1.
    expect(Math.max(...a.clusters.map((c) => c.weight))).toBeCloseTo(1, 6);
    for (const c of a.clusters) {
      expect(typeof c.x).toBe("number");
      expect(typeof c.y).toBe("number");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd FeralAgent && bun test tests/fractal-memory-activity.test.ts`
Expected: FAIL — `buildGrowActivity` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `fractal-memory.ts`, extend the `FractalActivity` union (the `grow` arm):

```ts
export type FractalActivity =
  | { kind: "recall"; hits: number }
  | {
      kind: "grow";
      leafCount: number;
      clusterCount: number;
      clusters: { x: number; y: number; weight: number }[];
    };
```

Add the import near the other fractal imports at the top of the file:

```ts
import { projectCentroids } from "./project-centroids.ts";
```

Add an exported pure helper (above the class, near the `FractalActivity` type):

```ts
/** Build the `grow` activity from a freshly built tree: real counts + 2D
 *  cluster positions (projected centroids) with leaf-count weights normalized
 *  to 0..1. Pure + exported so it can be unit-tested without a live tree. */
export function buildGrowActivity(tree: {
  leafIds: number[];
  children: { leafIds: number[]; centroid: Float32Array }[];
}): Extract<FractalActivity, { kind: "grow" }> {
  const points = projectCentroids(tree.children.map((c) => c.centroid));
  const counts = tree.children.map((c) => c.leafIds.length);
  const maxCount = Math.max(1, ...counts);
  const clusters = tree.children.map((c, i) => ({
    x: points[i]?.x ?? 0,
    y: points[i]?.y ?? 0,
    weight: counts[i]! / maxCount,
  }));
  return {
    kind: "grow",
    leafCount: tree.leafIds.length,
    clusterCount: tree.children.length,
    clusters,
  };
}
```

Replace the emit line in `#doRebuild` (was
`this.#emit({ kind: "grow", leafCount: tree.leafIds.length, clusterCount: tree.children.length });`):

```ts
    this.#emit(buildGrowActivity(tree));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd FeralAgent && bun test tests/fractal-memory-activity.test.ts tests/fractal-memory.test.ts`
Expected: PASS (new test + existing file green).

- [ ] **Step 5: Commit**

```bash
git add FeralAgent/src/memory/fractal/fractal-memory.ts FeralAgent/tests/fractal-memory-activity.test.ts
git commit -m "feat(fractal): grow event carries projected cluster positions + weights"
```

---

### Task 3: Power mapping + depth + warp feed in `signal.ts` (frontend)

**Files:**
- Modify: `frontend-react/src/lib/fractal/signal.ts`
- Test: `frontend-react/src/lib/fractal/__tests__/organism-signal.test.ts` (replace the power-lock describe block; keep the rest)

**Interfaces:**
- Consumes: nothing new (still `OrganismInput`).
- Produces: exported `powerForClusters(n: number): number` (rest value is 2.0 for
  `n ≤ 2`, otherwise in `[4.5, 5.0]`, never in the open `(2, 4.5)`), and
  `deriveOrganismState` now reads `input.clusterCount` for power and emits
  `warpSeeds` from `input.clusters`.

- [ ] **Step 1: Write the failing test** (replace the first `describe` block, add power-mapping cases)

```ts
// organism-signal.test.ts — replace the "power" describe with this:
import { deriveOrganismState, powerForClusters } from '@/lib/fractal/signal';

describe('powerForClusters — coarse signal that skips the ugly valley', () => {
  it('genesis: 2 or fewer clusters → exactly power 2', () => {
    for (const n of [0, 1, 2]) expect(powerForClusters(n)).toBe(2);
  });
  it('never rests in the open valley (2, 4.5)', () => {
    for (let n = 0; n <= 100000; n += 137) {
      const p = powerForClusters(n);
      expect(p === 2 || p >= 4.5).toBe(true);
    }
  });
  it('saturates at the cap 5.0', () => {
    expect(powerForClusters(100000)).toBeLessThanOrEqual(5);
    expect(powerForClusters(100000)).toBeGreaterThan(4.5);
  });
  it('more clusters → monotonically non-decreasing power', () => {
    let prev = 0;
    for (const n of [3, 8, 32, 256, 4096]) {
      const p = powerForClusters(n);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });
});

describe('deriveOrganismState — power from real clusters', () => {
  it('power is 2 for a newborn (0 clusters)', () => {
    const { state } = deriveOrganismState({ clusterCount: 0, eliteNodeCount: 0, rsi: null, persistedFloor: 0 });
    expect(state.power).toBe(2);
  });
  it('power climbs above the valley with many clusters', () => {
    const { state } = deriveOrganismState({ clusterCount: 64, eliteNodeCount: 0, rsi: null, persistedFloor: 0 });
    expect(state.power).toBeGreaterThanOrEqual(4.5);
  });
  it('warpSeeds come from provided clusters', () => {
    const { state } = deriveOrganismState({
      clusterCount: 2, eliteNodeCount: 10, rsi: null, persistedFloor: 0,
      clusters: [{ x: -0.5, y: 0.2, weight: 1 }, { x: -1.1, y: -0.3, weight: 0.5 }],
    });
    expect(state.warpSeeds).toHaveLength(2);
    expect(state.warpSeeds[0]).toMatchObject({ x: -0.5, y: 0.2 });
  });
});
```

NOTE: the existing `warpSeeds empty when no clusters provided` test (in the
"graceful null" block) stays valid and unchanged — keep it.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend-react && npx vitest run src/lib/fractal/__tests__/organism-signal.test.ts`
Expected: FAIL — `powerForClusters` is not exported; `power is 2 for newborn` may still pass but the cluster-climb test fails (power was locked at 2).

- [ ] **Step 3: Write minimal implementation**

In `signal.ts`, replace the `const MANDELBROT_POWER = 2;` line and the
`const power = MANDELBROT_POWER;` assignment. Add the mapping + constants:

```ts
// Power is a COARSE shape signal: classic cardioid (2) at genesis, easing into
// the 4.5..5 "several macro arms" band as real RAPTOR topics accumulate. It
// NEVER rests in the ugly doubled-blob valley (2, 4.5) — transitions sweep it
// only in motion (handled by the impulse easing layer).
export const POWER_GENESIS = 2;
export const POWER_VALLEY_HI = 4.5;
export const POWER_CAP = 5;
const GENESIS_CLUSTERS = 2;

export function powerForClusters(n: number): number {
  if (!Number.isFinite(n) || n <= GENESIS_CLUSTERS) return POWER_GENESIS;
  const frac = Math.min(1, Math.max(0, Math.log2(n) / Math.log2(64)));
  return POWER_VALLEY_HI + (POWER_CAP - POWER_VALLEY_HI) * frac;
}
```

Change the `REACTIVE_K` constant from `18` to `40` (more visible depth growth):

```ts
const REACTIVE_K = 40;       // depthBoost per log2 unit of living nodes (was 18)
```

In `deriveOrganismState`, destructure `clusterCount` and set power from it:

```ts
  const { clusterCount, eliteNodeCount, rsi, persistedFloor, clusters } = input;
  // ...
  const power = powerForClusters(clusterCount);
```

(Leave the `warpSeeds` mapping, floor, morph, and depthBoost logic as-is — they
already read `clusters` and `eliteNodeCount`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend-react && npx vitest run src/lib/fractal/__tests__/organism-signal.test.ts`
Expected: PASS (all blocks, including the unchanged floor/depth/null tests).

- [ ] **Step 5: Commit**

```bash
git add frontend-react/src/lib/fractal/signal.ts frontend-react/src/lib/fractal/__tests__/organism-signal.test.ts
git commit -m "feat(organism): power from real clusters (skips 3-4 valley) + stronger depth"
```

---

### Task 4: Domain-warp in the shader + uniform packing (frontend)

**Files:**
- Modify: `frontend-react/src/lib/fractal/organism.ts` (FRAG shader, uniforms, `render`)
- Test: `frontend-react/src/lib/fractal/__tests__/organism-warp.test.ts` (new)

**Interfaces:**
- Consumes: `WarpSeed` from `signal.ts` (`{ x, y, sigma, amp }`).
- Produces: exported `MAX_WARP = 32` and
  `packWarpUniforms(seeds: WarpSeed[]): { count: number; xy: Float32Array; sa: Float32Array }`
  — clamps to `MAX_WARP`, packs `xy` as `[x0,y0,x1,y1,...]` and `sa` as
  `[sigma0,amp0,...]`, each length `MAX_WARP*2`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend-react/src/lib/fractal/__tests__/organism-warp.test.ts
import { describe, it, expect } from 'vitest';
import { packWarpUniforms, MAX_WARP } from '@/lib/fractal/organism';
import type { WarpSeed } from '@/lib/fractal/signal';

const seed = (x: number, y: number, sigma = 0.12, amp = 1): WarpSeed => ({ x, y, sigma, amp });

describe('packWarpUniforms', () => {
  it('packs count, xy and sa interleaved', () => {
    const { count, xy, sa } = packWarpUniforms([seed(-0.5, 0.2, 0.1, 0.8)]);
    expect(count).toBe(1);
    expect(xy.length).toBe(MAX_WARP * 2);
    expect(sa.length).toBe(MAX_WARP * 2);
    expect([xy[0], xy[1]]).toEqual([-0.5, 0.2]);
    expect([sa[0], sa[1]]).toEqual([0.10000000149011612, 0.800000011920929].map((v) => Math.fround(v)));
  });
  it('clamps to MAX_WARP seeds', () => {
    const many = Array.from({ length: MAX_WARP + 10 }, (_, i) => seed(i, i));
    expect(packWarpUniforms(many).count).toBe(MAX_WARP);
  });
  it('empty seeds → count 0', () => {
    expect(packWarpUniforms([]).count).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend-react && npx vitest run src/lib/fractal/__tests__/organism-warp.test.ts`
Expected: FAIL — `packWarpUniforms` / `MAX_WARP` not exported.

- [ ] **Step 3: Write minimal implementation**

In `organism.ts`, add the export near the top (after imports):

```ts
import type { OrganismState, WarpSeed } from '@/lib/fractal/signal';

export const MAX_WARP = 32;

/** Pack warp seeds into fixed-length uniform arrays (clamped to MAX_WARP). */
export function packWarpUniforms(seeds: WarpSeed[]): { count: number; xy: Float32Array; sa: Float32Array } {
  const count = Math.min(seeds.length, MAX_WARP);
  const xy = new Float32Array(MAX_WARP * 2);
  const sa = new Float32Array(MAX_WARP * 2);
  for (let i = 0; i < count; i++) {
    const s = seeds[i]!;
    xy[i * 2] = s.x; xy[i * 2 + 1] = s.y;
    sa[i * 2] = s.sigma; sa[i * 2 + 1] = s.amp;
  }
  return { count, xy, sa };
}
```

Add warp uniforms to the `FRAG` string (after the existing `uniform int u_samples;` line):

```glsl
uniform int  u_warpCount;
uniform vec2 u_warpXY[32];
uniform vec2 u_warpSA[32];   // (sigma, amp) per seed

vec2 warp(vec2 c) {
  vec2 d = vec2(0.0);
  for (int i = 0; i < 32; i++) {
    if (i >= u_warpCount) break;
    vec2 diff = c - u_warpXY[i];
    float sigma = max(u_warpSA[i].x, 1e-3);
    float amp = u_warpSA[i].y;
    float g = exp(-dot(diff, diff) / (2.0 * sigma * sigma));
    d += amp * g * normalize(diff + vec2(1e-6));
  }
  return c + d * 0.15;
}
```

In the `escape` function, change the first line from
`vec2 ceff = mix(c, C_SEED, u_morph);` to:

```glsl
  vec2 ceff = mix(warp(c), C_SEED, u_morph);
```

In `createOrganismRenderer`, add the uniform locations next to the existing ones:

```ts
  const u_warpCount = U('u_warpCount'), u_warpXY = U('u_warpXY'), u_warpSA = U('u_warpSA');
```

In `render`, after `gl.uniform1f(u_morph, state.morph);`, set them:

```ts
    const warp = packWarpUniforms(state.warpSeeds);
    gl.uniform1i(u_warpCount, warp.count);
    gl.uniform2fv(u_warpXY, warp.xy);
    gl.uniform2fv(u_warpSA, warp.sa);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend-react && npx vitest run src/lib/fractal/__tests__/organism-warp.test.ts`
Expected: PASS (3 tests). (The GLSL itself is smoke-verified in-app later — jsdom has no WebGL.)

- [ ] **Step 5: Commit**

```bash
git add frontend-react/src/lib/fractal/organism.ts frontend-react/src/lib/fractal/__tests__/organism-warp.test.ts
git commit -m "feat(organism): GLSL domain-warp at cluster seeds + uniform packing"
```

---

### Task 5: Page wiring — real payload, no proxy, WebGL recovery (frontend)

**Files:**
- Modify: `frontend-react/src/lib/tauri/events.ts` (`FractalActivityLine` ~line 66-72)
- Modify: `frontend-react/src/pages/MemoryLayersPage.tsx`
- Test: `frontend-react/src/pages/__tests__/MemoryLayersPage.test.tsx`

**Interfaces:**
- Consumes: `deriveOrganismState` (Task 3) signature `{ clusterCount, eliteNodeCount, rsi, persistedFloor, clusters? }`; `FractalActivityLine` now has `clusters?`.
- Produces: page behavior — a `grow` event drives the organism from the event's
  real `clusterCount`/`leafCount`/`clusters` (NOT the node-type proxy); a lost
  WebGL context is recovered.

- [ ] **Step 1: Write the failing test** (add to the existing describe block)

```tsx
// MemoryLayersPage.test.tsx — add inside describe('MemoryLayersPage', ...)
import { deriveOrganismState } from '@/lib/fractal/signal';
import { listen } from '@tauri-apps/api/event';

it('a grow event derives from the event payload, not the node-type proxy', async () => {
  // Capture the fractal-activity callback the page registers.
  const handlers: ((e: any) => void)[] = [];
  (listen as any).mockImplementation((name: string, cb: (e: any) => void) => {
    if (name === 'feral://agent-output') handlers.push(cb);
    return Promise.resolve(() => {});
  });
  render(<MemoryLayersPage />);
  await vi.waitFor(() => expect(handlers.length).toBeGreaterThan(0));
  (deriveOrganismState as any).mockClear();
  // Emit a grow line with real cluster data.
  const grow = { type: 'fractal_activity', kind: 'grow', leafCount: 500, clusterCount: 64,
                 clusters: [{ x: -0.5, y: 0.1, weight: 1 }] };
  for (const cb of handlers) cb({ payload: JSON.stringify(grow) });
  await vi.waitFor(() => expect(deriveOrganismState).toHaveBeenCalled());
  const arg = (deriveOrganismState as any).mock.calls.at(-1)[0];
  expect(arg.clusterCount).toBe(64);
  expect(arg.eliteNodeCount).toBe(500);
  expect(arg.clusters).toEqual([{ x: -0.5, y: 0.1, weight: 1 }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend-react && npx vitest run src/pages/__tests__/MemoryLayersPage.test.tsx`
Expected: FAIL — the page calls `refresh()` (proxy) on `grow`, so `deriveOrganismState` is called with `clusterCount=1` (node-type count), not 64.

- [ ] **Step 3: Write minimal implementation**

In `events.ts`, extend the interface:

```ts
export interface FractalActivityLine {
  type: 'fractal_activity';
  kind: 'recall' | 'grow';
  hits?: number;
  leafCount?: number;
  clusterCount?: number;
  clusters?: { x: number; y: number; weight: number }[];
}
```

In `MemoryLayersPage.tsx`, add a payload-driven derive helper and use it in the
`grow` branch. Add this `useCallback` near `refresh`:

```tsx
  // Derive directly from a `grow` event's real RAPTOR payload — no node-type proxy.
  const growFrom = useCallback(async (line: { leafCount?: number; clusterCount?: number; clusters?: { x: number; y: number; weight: number }[] }) => {
    const rsi = await tauri.rsi.status().catch(() => null);
    const { state, floor } = deriveOrganismState({
      clusterCount: line.clusterCount ?? 0,
      eliteNodeCount: line.leafCount ?? 0,
      rsi,
      persistedFloor: maturity.current(),
      clusters: line.clusters ?? [],
    });
    maturity.bump(floor);
    impulseTo(stateRef.current, state);
  }, [impulseTo]);
```

Change the fractal-activity effect's `grow` branch from `void refresh()` to:

```tsx
      if (e.kind === 'grow') void growFrom(e);
      else if (e.kind === 'recall') startBreathing();
```

Update that effect's dependency array to include `growFrom`:

```tsx
  }, [growFrom, startBreathing]);
```

Add WebGL context-loss recovery in the one-time renderer `useEffect` (after
`rendererRef.current = r; draw();`):

```tsx
    const onLost = (ev: Event) => { ev.preventDefault(); rendererRef.current = null; };
    const onRestored = () => {
      const r2 = createOrganismRenderer(canvas);
      if (r2) { rendererRef.current = r2; draw(); }
    };
    canvas.addEventListener('webglcontextlost', onLost as EventListener);
    canvas.addEventListener('webglcontextrestored', onRestored as EventListener);
```

and in that effect's cleanup, remove them:

```tsx
      canvas.removeEventListener('webglcontextlost', onLost as EventListener);
      canvas.removeEventListener('webglcontextrestored', onRestored as EventListener);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend-react && npx vitest run src/pages/__tests__/MemoryLayersPage.test.tsx`
Expected: PASS (mount test + new grow-payload test).

- [ ] **Step 5: Full suite + typecheck + commit**

Run: `cd frontend-react && npx vitest run && npx tsc --noEmit`
Expected: all green, no type errors.

```bash
git add frontend-react/src/lib/tauri/events.ts frontend-react/src/pages/MemoryLayersPage.tsx frontend-react/src/pages/__tests__/MemoryLayersPage.test.tsx
git commit -m "feat(organism): drive growth from real grow payload + WebGL context-loss recovery"
```

---

### Task 6: Build sidecar + manual in-app smoke verification

**Files:** none (build + manual check).

- [ ] **Step 1: Rebuild + install the sidecar** (Task 1/2 changed sidecar TS)

```bash
cd FeralAgent && bun run build
cp dist/feral-agent.exe ../src-tauri/binaries/feral-agent-x86_64-pc-windows-msvc.exe
```

- [ ] **Step 2: Full sidecar + frontend test suites**

Run: `cd FeralAgent && bun test` then `cd ../frontend-react && npx vitest run`
Expected: both suites green.

- [ ] **Step 3: Manual visual smoke (the GLSL can't run in jsdom)**

Launch the app (`run-app-ui.bat` or `cargo tauri dev`), open Memory Layers:
- Fresh/empty memory → clean cardioid (power 2), GPU idle at rest.
- Trigger a memory rebuild (recall/grow) → organism eases smoothly to a denser,
  warped form with macro arms (power ≥4.5 at many clusters); morph breathes once
  then freezes.
- Confirm no permanent black screen after a tab backgrounding / context loss.

- [ ] **Step 4: Commit (if the rebuilt binary is tracked; it is gitignored here, so usually nothing to commit)**

```bash
git status   # binaries/*.exe is gitignored — expect no change to commit
```

---

## Self-Review

**Spec coverage:**
- §4.1 projectCentroids → Task 1 ✓; grow payload w/ clusters → Task 2 ✓
- §4.2 events.ts type → Task 5 ✓
- §4.3 power mapping (rest 2 or ≥4.5), depth, warp feed → Task 3 ✓
- §4.4 page drops proxy, derives from payload → Task 5 ✓
- §4.5 shader domain-warp → Task 4 ✓
- §4.6 atrophy (eased down, floor clamp) → covered by Task 3 (floor unchanged) + impulse easing; no new code needed ✓
- §4.7 WebGL context-loss + guards → Task 5 (context-loss) + Task 1/2 empty-input guards ✓
- §5 testing → each task is TDD; shader manual smoke in Task 6 ✓
- §6 out of scope (ghost cards / embedding) → not in any task ✓

**Placeholder scan:** no TBD/TODO; every code step shows full code. ✓

**Type consistency:** `projectCentroids`/`Point2D` (Task 1) consumed in Task 2; `buildGrowActivity` shape `{kind,leafCount,clusterCount,clusters}` matches `FractalActivityLine` (Task 5) and `deriveOrganismState` input `clusters` (Task 3); `WarpSeed` from signal used by `packWarpUniforms` (Task 4) and the existing `warpSeeds` mapping. ✓
