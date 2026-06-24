# Organism Tree Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Mandelbrot fractal visualization with a static, deterministic, data-reactive "Feral ember-oak" tree rendered in WebGL2.

**Architecture:** Pure TS stages — `deriveTreeState` → `generateSkeleton` (seeded, deterministic) → `skeletonToBuffers` → a thin WebGL2 `TreeRenderer`. All logic lives in small, unit-tested pure modules under `frontend-react/src/lib/tree/`; the renderer is a thin GL adapter verified manually. `MemoryLayersPage` is rewired off the fractal modules, which are deleted.

**Tech Stack:** TypeScript, React, WebGL2, Vitest.

## Global Constraints

- Test runner: **Vitest** (`npm test` / `vitest run`). Test files: `*.test.ts` colocated in `__tests__/`.
- Work in worktree `feat/organism-tree` (`.worktrees/wt-tree`). All paths below are relative to `frontend-react/`.
- TypeScript strict — no `any` in committed code; prefer `Float32Array` for GPU buffers.
- Coordinate convention: tree-space is canvas-normalized `[0,1]`, **y up** (0 = ground/bottom, 1 = top). The renderer maps to clip space.
- Brand palette: near-black background `#0a0a0b`; bark dark `#241a12` → warm rim `#5a3a1e`; foliage amber `#d98a2b` → orange `#e8541e`.
- Reuse the existing monotonic maturity constants so growth semantics match today: `FLOOR_ITER_A = 0.02`, `FLOOR_BOUNDS_B = 40`.
- **Do NOT touch** `FeralAgent/src/rsi/escape-time*.ts` / engine `fractal.ts` — that is RSI selection, not the viz.

---

### Task 1: Seeded RNG + tree contract types

**Files:**
- Create: `src/lib/tree/rng.ts`
- Create: `src/lib/tree/contract.ts`
- Test: `src/lib/tree/__tests__/rng.test.ts`

**Interfaces:**
- Produces: `mulberry32(seed: number): () => number` — deterministic PRNG in `[0,1)`.
- Produces: `hashSeed(s: string): number` — string → 32-bit seed.
- Produces: `interface TreeInput { clusterCount: number; eliteNodeCount: number; rsi: { iteration: number; boundsVersion: number } | null; persistedFloor: number; clusters: { x: number; y: number; weight: number }[] }`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/tree/__tests__/rng.test.ts
import { describe, it, expect } from 'vitest';
import { mulberry32, hashSeed } from '../rng';

describe('mulberry32', () => {
  it('is deterministic for the same seed', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const seqA = [a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it('produces values in [0,1) and differs across seeds', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const va = a(), vb = b();
    expect(va).toBeGreaterThanOrEqual(0);
    expect(va).toBeLessThan(1);
    expect(va).not.toEqual(vb);
  });

  it('hashSeed maps strings to stable 32-bit seeds', () => {
    expect(hashSeed('feral')).toBe(hashSeed('feral'));
    expect(hashSeed('feral')).not.toBe(hashSeed('feline'));
    expect(Number.isInteger(hashSeed('x'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/tree/__tests__/rng.test.ts`
Expected: FAIL — cannot find module `../rng`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/tree/rng.ts
/** Deterministic 32-bit PRNG (mulberry32). Same seed ⇒ same sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable string → 32-bit seed (xmur3-style). */
export function hashSeed(s: string): number {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h >>> 0);
}
```

```ts
// src/lib/tree/contract.ts
/** The reactive data contract — memory clusters + RSI maturity. This is
 *  the surviving signal from the old fractal `OrganismInput`; only its
 *  interpretation changes (fractal params → tree params). */
export interface TreeInput {
  /** Distinct memory clusters (node-type diversity proxy). */
  clusterCount: number;
  /** Surviving ("elite") node count — the reactive foliage volume. */
  eliteNodeCount: number;
  /** RSI maturity signal; null before the engine has run. */
  rsi: { iteration: number; boundsVersion: number } | null;
  /** Persisted monotonic maturity floor. */
  persistedFloor: number;
  /** Cluster positions (for limb bias); may be empty. */
  clusters: { x: number; y: number; weight: number }[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/tree/__tests__/rng.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/tree/rng.ts src/lib/tree/contract.ts src/lib/tree/__tests__/rng.test.ts
git commit -m "feat(tree): seeded RNG + reactive tree data contract"
```

---

### Task 2: deriveTreeState — contract → tree parameters

**Files:**
- Create: `src/lib/tree/treeState.ts`
- Test: `src/lib/tree/__tests__/treeState.test.ts`

**Interfaces:**
- Consumes: `TreeInput` (Task 1).
- Produces:
```ts
interface TreeState {
  trunkHeight: number; trunkGirth: number; primaryLimbs: number;
  depth: number; leafCount: number; limbBias: number[];
}
interface DerivedTree { state: TreeState; floor: number }
function deriveTreeState(input: TreeInput): DerivedTree
```
- Produces constants: `MIN_LIMBS = 2`, `MAX_LIMBS = 7`, `MAX_LEAVES = 600`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/tree/__tests__/treeState.test.ts
import { describe, it, expect } from 'vitest';
import { deriveTreeState, MIN_LIMBS, MAX_LIMBS, MAX_LEAVES } from '../treeState';
import type { TreeInput } from '../contract';

const base: TreeInput = { clusterCount: 3, eliteNodeCount: 40, rsi: { iteration: 100, boundsVersion: 0 }, persistedFloor: 0, clusters: [] };

describe('deriveTreeState', () => {
  it('maps cluster count to primary limbs, clamped', () => {
    expect(deriveTreeState({ ...base, clusterCount: 4 }).state.primaryLimbs).toBe(4);
    expect(deriveTreeState({ ...base, clusterCount: 1 }).state.primaryLimbs).toBe(MIN_LIMBS);
    expect(deriveTreeState({ ...base, clusterCount: 99 }).state.primaryLimbs).toBe(MAX_LIMBS);
  });

  it('leaf count grows with elite node count and is capped', () => {
    const few = deriveTreeState({ ...base, eliteNodeCount: 10 }).state.leafCount;
    const many = deriveTreeState({ ...base, eliteNodeCount: 200 }).state.leafCount;
    expect(many).toBeGreaterThan(few);
    expect(deriveTreeState({ ...base, eliteNodeCount: 100000 }).state.leafCount).toBe(MAX_LEAVES);
  });

  it('floor is monotonic — never below the persisted floor', () => {
    const d = deriveTreeState({ ...base, persistedFloor: 999, rsi: { iteration: 1, boundsVersion: 0 } });
    expect(d.floor).toBe(999);
  });

  it('higher RSI iteration never yields a shorter trunk', () => {
    const young = deriveTreeState({ ...base, rsi: { iteration: 10, boundsVersion: 0 } }).state.trunkHeight;
    const old = deriveTreeState({ ...base, rsi: { iteration: 1000, boundsVersion: 0 } }).state.trunkHeight;
    expect(old).toBeGreaterThanOrEqual(young);
  });

  it('empty clusters give a symmetric (all-zero) limb bias of the right length', () => {
    const s = deriveTreeState({ ...base, clusterCount: 5, clusters: [] }).state;
    expect(s.limbBias).toHaveLength(5);
    expect(s.limbBias.every((b) => b === 0)).toBe(true);
  });

  it('genesis (no rsi, zero nodes) is a small sapling with no leaves', () => {
    const s = deriveTreeState({ clusterCount: 0, eliteNodeCount: 0, rsi: null, persistedFloor: 0, clusters: [] }).state;
    expect(s.leafCount).toBe(0);
    expect(s.primaryLimbs).toBe(MIN_LIMBS);
    expect(s.trunkHeight).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/tree/__tests__/treeState.test.ts`
Expected: FAIL — cannot find module `../treeState`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/tree/treeState.ts
import type { TreeInput } from './contract';

export const MIN_LIMBS = 2;
export const MAX_LIMBS = 7;
export const MAX_LEAVES = 600;

const FLOOR_ITER_A = 0.02;     // floor per RSI iteration (lifetime maturity)
const FLOOR_BOUNDS_B = 40;     // floor step per bounds_version (paradigm shift)
const LEAVES_PER_NODE = 1.5;   // foliage volume per surviving node

export interface TreeState {
  /** Trunk height, normalized 0..1 of canvas height. */
  trunkHeight: number;
  /** Trunk base half-width, normalized. */
  trunkGirth: number;
  /** Primary limbs off the trunk = clamped cluster count. */
  primaryLimbs: number;
  /** Branch recursion depth (older ⇒ deeper). */
  depth: number;
  /** Target leaf count ∝ elite node count, capped. */
  leafCount: number;
  /** Per-limb angular bias (radians); 0 when no cluster position. */
  limbBias: number[];
}

export interface DerivedTree { state: TreeState; floor: number }

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** Saturating 0..1 growth curve — fast early, asymptotes so a very old
 *  tree never overflows the frame. */
const saturate = (x: number, k: number) => 1 - Math.exp(-x / k);

export function deriveTreeState(input: TreeInput): DerivedTree {
  const iter = input.rsi?.iteration ?? 0;
  const boundsVersion = input.rsi?.boundsVersion ?? 0;

  const floorCandidate = FLOOR_ITER_A * iter + FLOOR_BOUNDS_B * boundsVersion;
  const floor = Math.max(input.persistedFloor, floorCandidate, 0);

  // Maturity drives size via a saturating curve. Sapling baseline 0.18 so
  // genesis still shows something; asymptote ~0.18 + 0.5 = 0.68 of height.
  const m = saturate(floor, 120);
  const trunkHeight = 0.18 + 0.5 * m;
  const trunkGirth = 0.012 + 0.05 * m;
  const depth = Math.round(clamp(2 + floor / 60, 2, 6));

  const primaryLimbs = clamp(Math.round(input.clusterCount), MIN_LIMBS, MAX_LIMBS);
  const leafCount = clamp(Math.round(input.eliteNodeCount * LEAVES_PER_NODE), 0, MAX_LEAVES);

  const limbBias: number[] = [];
  for (let i = 0; i < primaryLimbs; i++) {
    const c = input.clusters[i];
    // Lean toward the cluster's horizontal position (x in [-1,1] → bias).
    limbBias.push(c ? clamp(c.x, -1, 1) * 0.4 : 0);
  }

  return { state: { trunkHeight, trunkGirth, primaryLimbs, depth, leafCount, limbBias }, floor };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/tree/__tests__/treeState.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/tree/treeState.ts src/lib/tree/__tests__/treeState.test.ts
git commit -m "feat(tree): deriveTreeState — contract to tree parameters"
```

---

### Task 3: generateSkeleton — parameters → deterministic branch graph

**Files:**
- Create: `src/lib/tree/skeleton.ts`
- Test: `src/lib/tree/__tests__/skeleton.test.ts`

**Interfaces:**
- Consumes: `TreeState` (Task 2), `mulberry32` (Task 1).
- Produces:
```ts
interface Segment { x0: number; y0: number; x1: number; y1: number; width0: number; width1: number; depth: number }
interface Leaf { x: number; y: number; size: number; angle: number; clusterId: number }
interface Skeleton { segments: Segment[]; leaves: Leaf[] }
function generateSkeleton(state: TreeState, seed: number): Skeleton
```

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/tree/__tests__/skeleton.test.ts
import { describe, it, expect } from 'vitest';
import { generateSkeleton } from '../skeleton';
import { deriveTreeState } from '../treeState';
import type { TreeInput } from '../contract';

const input: TreeInput = { clusterCount: 4, eliteNodeCount: 50, rsi: { iteration: 200, boundsVersion: 0 }, persistedFloor: 0, clusters: [] };
const state = deriveTreeState(input).state;

describe('generateSkeleton', () => {
  it('is deterministic for the same state + seed', () => {
    const a = generateSkeleton(state, 42);
    const b = generateSkeleton(state, 42);
    expect(a).toEqual(b);
  });

  it('different seeds produce different skeletons', () => {
    const a = generateSkeleton(state, 1);
    const b = generateSkeleton(state, 2);
    expect(a).not.toEqual(b);
  });

  it('emits the trunk as depth-0 segment(s) plus one branch per primary limb', () => {
    const skel = generateSkeleton(state, 7);
    expect(skel.segments.some((s) => s.depth === 0)).toBe(true);
    const limbRoots = skel.segments.filter((s) => s.depth === 1);
    expect(limbRoots.length).toBe(state.primaryLimbs);
  });

  it('places exactly the requested number of leaves (bounded by capacity)', () => {
    const skel = generateSkeleton(state, 7);
    expect(skel.leaves.length).toBe(state.leafCount);
  });

  it('growth is monotonic: a more mature state keeps the trunk anchored at the same base', () => {
    const young = generateSkeleton(deriveTreeState({ ...input, rsi: { iteration: 50, boundsVersion: 0 } }).state, 7);
    const old = generateSkeleton(deriveTreeState({ ...input, rsi: { iteration: 5000, boundsVersion: 0 } }).state, 7);
    // Trunk base is anchored at canvas bottom-center for both.
    const baseYoung = young.segments.find((s) => s.depth === 0)!;
    const baseOld = old.segments.find((s) => s.depth === 0)!;
    expect(baseOld.x0).toBeCloseTo(baseYoung.x0, 5);
    expect(baseOld.y0).toBeCloseTo(baseYoung.y0, 5);
    // Older trunk reaches at least as high.
    expect(baseOld.y1).toBeGreaterThanOrEqual(baseYoung.y1);
  });

  it('respects recursion depth (no segment deeper than state.depth)', () => {
    const skel = generateSkeleton(state, 7);
    expect(Math.max(...skel.segments.map((s) => s.depth))).toBeLessThanOrEqual(state.depth);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/tree/__tests__/skeleton.test.ts`
Expected: FAIL — cannot find module `../skeleton`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/tree/skeleton.ts
import { mulberry32 } from './rng';
import type { TreeState } from './treeState';

export interface Segment {
  x0: number; y0: number; x1: number; y1: number;
  width0: number; width1: number; depth: number;
}
export interface Leaf { x: number; y: number; size: number; angle: number; clusterId: number }
export interface Skeleton { segments: Segment[]; leaves: Leaf[] }

const TRUNK_X = 0.5;     // anchored bottom-center
const TRUNK_Y = 0.02;    // small offset off the very bottom edge
const LENGTH_DECAY = 0.7;
const WIDTH_DECAY = 0.62;
const SPREAD = 0.5;      // base half-angle (radians) between sibling branches

export function generateSkeleton(state: TreeState, seed: number): Skeleton {
  const rng = mulberry32(seed);
  const segments: Segment[] = [];
  const terminals: { x: number; y: number; clusterId: number }[] = [];

  // 1. Trunk — a single depth-0 segment straight up.
  const trunkTopX = TRUNK_X;
  const trunkTopY = TRUNK_Y + state.trunkHeight;
  segments.push({
    x0: TRUNK_X, y0: TRUNK_Y, x1: trunkTopX, y1: trunkTopY,
    width0: state.trunkGirth, width1: state.trunkGirth * WIDTH_DECAY, depth: 0,
  });

  // 2. Primary limbs fan out from the trunk top, then recurse.
  const limbLen = state.trunkHeight * 0.55;
  for (let i = 0; i < state.primaryLimbs; i++) {
    // Symmetric fan centered on vertical (angle 0 = straight up), biased.
    const t = state.primaryLimbs === 1 ? 0 : (i / (state.primaryLimbs - 1)) * 2 - 1; // -1..1
    const baseAngle = t * SPREAD * 1.6 + (state.limbBias[i] ?? 0);
    grow(
      segments, terminals, rng,
      trunkTopX, trunkTopY, baseAngle, limbLen,
      state.trunkGirth * WIDTH_DECAY, 1, state.depth, i,
    );
  }

  // 3. Leaves on terminals, round-robin until leafCount placed.
  const leaves: Leaf[] = [];
  if (terminals.length > 0) {
    for (let n = 0; n < state.leafCount; n++) {
      const term = terminals[n % terminals.length];
      const jx = (rng() - 0.5) * 0.03;
      const jy = (rng() - 0.5) * 0.03;
      leaves.push({
        x: term.x + jx, y: term.y + jy,
        size: 0.012 + rng() * 0.01,
        angle: rng() * Math.PI * 2,
        clusterId: term.clusterId,
      });
    }
  }

  return { segments, leaves };
}

function grow(
  segments: Segment[], terminals: { x: number; y: number; clusterId: number }[],
  rng: () => number,
  x: number, y: number, angle: number, length: number, width: number,
  depth: number, maxDepth: number, clusterId: number,
): void {
  // angle: 0 = straight up; positive = lean right.
  const jitter = (rng() - 0.5) * 0.25;
  const a = angle + jitter;
  const x1 = x + Math.sin(a) * length;
  const y1 = y + Math.cos(a) * length;
  const w1 = width * WIDTH_DECAY;
  segments.push({ x0: x, y0: y, x1, y1, width0: width, width1: w1, depth });

  if (depth >= maxDepth) {
    terminals.push({ x: x1, y: y1, clusterId });
    return;
  }
  // Two children, splayed.
  const childLen = length * LENGTH_DECAY;
  grow(segments, terminals, rng, x1, y1, a - SPREAD, childLen, w1, depth + 1, maxDepth, clusterId);
  grow(segments, terminals, rng, x1, y1, a + SPREAD, childLen, w1, depth + 1, maxDepth, clusterId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/tree/__tests__/skeleton.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/tree/skeleton.ts src/lib/tree/__tests__/skeleton.test.ts
git commit -m "feat(tree): deterministic procedural skeleton generation"
```

---

### Task 4: skeletonToBuffers — skeleton → GPU buffers

**Files:**
- Create: `src/lib/tree/geometry.ts`
- Test: `src/lib/tree/__tests__/geometry.test.ts`

**Interfaces:**
- Consumes: `Skeleton`, `Segment`, `Leaf` (Task 3).
- Produces:
```ts
interface TreeBuffers {
  branchPositions: Float32Array;  // 2 floats * 6 verts * nSegments
  branchShade: Float32Array;      // 1 float * 6 verts * nSegments
  leafInstances: Float32Array;    // 4 floats per leaf [x,y,size,angle]
  branchVertexCount: number;
  leafInstanceCount: number;
}
function skeletonToBuffers(skel: Skeleton): TreeBuffers
```

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/tree/__tests__/geometry.test.ts
import { describe, it, expect } from 'vitest';
import { skeletonToBuffers } from '../geometry';
import type { Skeleton } from '../skeleton';

const skel: Skeleton = {
  segments: [
    { x0: 0.5, y0: 0, x1: 0.5, y1: 0.3, width0: 0.05, width1: 0.03, depth: 0 },
    { x0: 0.5, y0: 0.3, x1: 0.6, y1: 0.5, width0: 0.03, width1: 0.02, depth: 1 },
  ],
  leaves: [
    { x: 0.6, y: 0.5, size: 0.02, angle: 1.0, clusterId: 0 },
    { x: 0.55, y: 0.48, size: 0.015, angle: 2.0, clusterId: 1 },
  ],
};

describe('skeletonToBuffers', () => {
  it('emits 6 vertices (12 floats) per segment for the ribbon', () => {
    const b = skeletonToBuffers(skel);
    expect(b.branchVertexCount).toBe(skel.segments.length * 6);
    expect(b.branchPositions.length).toBe(skel.segments.length * 6 * 2);
    expect(b.branchShade.length).toBe(skel.segments.length * 6);
  });

  it('emits 4 floats per leaf instance', () => {
    const b = skeletonToBuffers(skel);
    expect(b.leafInstanceCount).toBe(skel.leaves.length);
    expect(b.leafInstances.length).toBe(skel.leaves.length * 4);
    expect(Array.from(b.leafInstances.slice(0, 4))).toEqual([0.6, 0.5, 0.02, 1.0]);
  });

  it('deeper segments are shaded brighter (warm rim grows toward tips)', () => {
    const b = skeletonToBuffers(skel);
    // First vertex of segment 0 (depth 0) vs segment 1 (depth 1).
    const shade0 = b.branchShade[0];
    const shade1 = b.branchShade[6];
    expect(shade1).toBeGreaterThan(shade0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/tree/__tests__/geometry.test.ts`
Expected: FAIL — cannot find module `../geometry`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/tree/geometry.ts
import type { Skeleton } from './skeleton';

export interface TreeBuffers {
  branchPositions: Float32Array;
  branchShade: Float32Array;
  leafInstances: Float32Array;
  branchVertexCount: number;
  leafInstanceCount: number;
}

const MAX_SHADE_DEPTH = 6;

/** Convert each tapered segment into a 2-triangle ribbon quad and each
 *  leaf into a [x,y,size,angle] instance. Pure — no GL context needed. */
export function skeletonToBuffers(skel: Skeleton): TreeBuffers {
  const nSeg = skel.segments.length;
  const positions = new Float32Array(nSeg * 6 * 2);
  const shade = new Float32Array(nSeg * 6);

  for (let i = 0; i < nSeg; i++) {
    const s = skel.segments[i];
    const dx = s.x1 - s.x0;
    const dy = s.y1 - s.y0;
    const len = Math.hypot(dx, dy) || 1e-6;
    // Perpendicular unit vector for ribbon width.
    const nx = -dy / len;
    const ny = dx / len;
    const w0 = s.width0, w1 = s.width1;

    // Four corners of the ribbon quad.
    const ax = s.x0 + nx * w0, ay = s.y0 + ny * w0; // base-left
    const bx = s.x0 - nx * w0, by = s.y0 - ny * w0; // base-right
    const cx = s.x1 + nx * w1, cy = s.y1 + ny * w1; // tip-left
    const ex = s.x1 - nx * w1, ey = s.y1 - ny * w1; // tip-right

    const o = i * 12;
    // Triangle 1: a, b, c ; Triangle 2: b, e, c
    positions.set([ax, ay, bx, by, cx, cy, bx, by, ex, ey, cx, cy], o);

    const sh = Math.min(s.depth / MAX_SHADE_DEPTH, 1);
    for (let v = 0; v < 6; v++) shade[i * 6 + v] = sh;
  }

  const nLeaf = skel.leaves.length;
  const leafInstances = new Float32Array(nLeaf * 4);
  for (let i = 0; i < nLeaf; i++) {
    const l = skel.leaves[i];
    leafInstances.set([l.x, l.y, l.size, l.angle], i * 4);
  }

  return {
    branchPositions: positions,
    branchShade: shade,
    leafInstances,
    branchVertexCount: nSeg * 6,
    leafInstanceCount: nLeaf,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/tree/__tests__/geometry.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/tree/geometry.ts src/lib/tree/__tests__/geometry.test.ts
git commit -m "feat(tree): skeleton-to-GPU-buffer geometry builder"
```

---

### Task 5: createTreeRenderer — thin WebGL2 adapter

**Files:**
- Create: `src/lib/tree/renderer.ts`
- Test: `src/lib/tree/__tests__/renderer.test.ts`

**Interfaces:**
- Consumes: `TreeBuffers` (Task 4).
- Produces:
```ts
interface TreeView { aspect: number }
interface TreeRenderer { draw(buffers: TreeBuffers, view: TreeView): void; resize(): void; dispose(): void }
function createTreeRenderer(canvas: HTMLCanvasElement): TreeRenderer | null
```
- Contract: returns `null` when WebGL2 is unavailable (so the page can show the existing fallback). No animation loop (Phase 1 draws on demand).

> The render output itself is verified manually in the running app. The unit test only asserts the **null-on-no-WebGL2 contract**, which is the branch `MemoryLayersPage` depends on.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/tree/__tests__/renderer.test.ts
import { describe, it, expect } from 'vitest';
import { createTreeRenderer } from '../renderer';

describe('createTreeRenderer', () => {
  it('returns null when WebGL2 is unavailable', () => {
    const fake = { getContext: () => null } as unknown as HTMLCanvasElement;
    expect(createTreeRenderer(fake)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/tree/__tests__/renderer.test.ts`
Expected: FAIL — cannot find module `../renderer`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/tree/renderer.ts
import type { TreeBuffers } from './geometry';

export interface TreeView { aspect: number }
export interface TreeRenderer {
  draw(buffers: TreeBuffers, view: TreeView): void;
  resize(): void;
  dispose(): void;
}

const BG: [number, number, number] = [0.039, 0.039, 0.043]; // #0a0a0b

const BRANCH_VS = `#version 300 es
in vec2 a_pos;
in float a_shade;
uniform float u_aspect;
out float v_shade;
void main() {
  v_shade = a_shade;
  // tree-space [0,1] (y up) → clip space, x corrected for aspect.
  vec2 p = a_pos * 2.0 - 1.0;
  p.x /= u_aspect;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const BRANCH_FS = `#version 300 es
precision highp float;
in float v_shade;
out vec4 outColor;
void main() {
  vec3 darkBark = vec3(0.141, 0.102, 0.071);  // #241a12
  vec3 warmRim  = vec3(0.353, 0.227, 0.118);  // #5a3a1e
  outColor = vec4(mix(darkBark, warmRim, v_shade), 1.0);
}`;

const LEAF_VS = `#version 300 es
in vec2 a_corner;      // unit quad corner (-0.5..0.5)
in vec4 a_inst;        // x, y, size, angle
uniform float u_aspect;
out vec2 v_uv;
void main() {
  v_uv = a_corner + 0.5;
  float s = sin(a_inst.w), c = cos(a_inst.w);
  vec2 r = vec2(a_corner.x * c - a_corner.y * s, a_corner.x * s + a_corner.y * c);
  vec2 pos = a_inst.xy + r * a_inst.z;
  vec2 p = pos * 2.0 - 1.0;
  p.x /= u_aspect;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const LEAF_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
void main() {
  // Round leaf mask via distance from center; alpha-test the rim.
  float d = distance(v_uv, vec2(0.5));
  if (d > 0.5) discard;
  vec3 amber  = vec3(0.851, 0.541, 0.169);  // #d98a2b
  vec3 orange = vec3(0.910, 0.329, 0.118);  // #e8541e
  vec3 col = mix(amber, orange, v_uv.y);
  float edge = smoothstep(0.5, 0.35, d);
  outColor = vec4(col, edge);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error('tree shader compile failed:', gl.getShaderInfoLog(sh));
    return null;
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) return null;
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('tree program link failed:', gl.getProgramInfoLog(prog));
    return null;
  }
  return prog;
}

export function createTreeRenderer(canvas: HTMLCanvasElement): TreeRenderer | null {
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
  if (!gl) return null;

  const branchProg = link(gl, BRANCH_VS, BRANCH_FS);
  const leafProg = link(gl, LEAF_VS, LEAF_FS);
  if (!branchProg || !leafProg) return null;

  // Branch buffers.
  const branchVAO = gl.createVertexArray();
  gl.bindVertexArray(branchVAO);
  const posBuf = gl.createBuffer();
  const shadeBuf = gl.createBuffer();
  const aPos = gl.getAttribLocation(branchProg, 'a_pos');
  const aShade = gl.getAttribLocation(branchProg, 'a_shade');
  const uBranchAspect = gl.getUniformLocation(branchProg, 'u_aspect');

  // Leaf buffers (unit quad + instanced attributes).
  const leafVAO = gl.createVertexArray();
  gl.bindVertexArray(leafVAO);
  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5,
  ]), gl.STATIC_DRAW);
  const aCorner = gl.getAttribLocation(leafProg, 'a_corner');
  gl.enableVertexAttribArray(aCorner);
  gl.vertexAttribPointer(aCorner, 2, gl.FLOAT, false, 0, 0);
  const instBuf = gl.createBuffer();
  const aInst = gl.getAttribLocation(leafProg, 'a_inst');
  const uLeafAspect = gl.getUniformLocation(leafProg, 'u_aspect');

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, canvas.width, canvas.height);
  };

  const draw = (buffers: TreeBuffers, view: TreeView) => {
    resize();
    gl.clearColor(BG[0], BG[1], BG[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Branches (opaque).
    gl.useProgram(branchProg);
    gl.bindVertexArray(branchVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, buffers.branchPositions, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, shadeBuf);
    gl.bufferData(gl.ARRAY_BUFFER, buffers.branchShade, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(aShade);
    gl.vertexAttribPointer(aShade, 1, gl.FLOAT, false, 0, 0);
    gl.uniform1f(uBranchAspect, view.aspect);
    gl.drawArrays(gl.TRIANGLES, 0, buffers.branchVertexCount);

    // Leaves (alpha-blended, instanced).
    gl.useProgram(leafProg);
    gl.bindVertexArray(leafVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, buffers.leafInstances, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(aInst);
    gl.vertexAttribPointer(aInst, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(aInst, 1);
    gl.uniform1f(uLeafAspect, view.aspect);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, buffers.leafInstanceCount);
    gl.disable(gl.BLEND);
  };

  const dispose = () => {
    gl.deleteProgram(branchProg);
    gl.deleteProgram(leafProg);
    gl.deleteBuffer(posBuf); gl.deleteBuffer(shadeBuf);
    gl.deleteBuffer(quadBuf); gl.deleteBuffer(instBuf);
    gl.deleteVertexArray(branchVAO); gl.deleteVertexArray(leafVAO);
  };

  return { draw, resize, dispose };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/tree/__tests__/renderer.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/lib/tree/renderer.ts src/lib/tree/__tests__/renderer.test.ts
git commit -m "feat(tree): thin WebGL2 tree renderer (branches + instanced leaves)"
```

---

### Task 6: Rewire MemoryLayersPage + remove Mandelbrot

**Files:**
- Modify: `src/pages/MemoryLayersPage.tsx`
- Delete: `src/lib/fractal/organism.ts`, `src/lib/fractal/escape.ts`, `src/lib/fractal/breathing.ts`, `src/lib/fractal/signal.ts`, `src/hooks/useOrganismImpulse.ts`
- Delete: `src/lib/fractal/__tests__/*` (fractal-only tests)
- Keep: `src/lib/fractal/maturity.ts` → move to `src/lib/tree/maturity.ts` (floor store, semantics unchanged)
- Test: `src/pages/__tests__/MemoryLayersPage.test.tsx` (update)

**Interfaces:**
- Consumes: `deriveTreeState` (T2), `generateSkeleton` (T3), `skeletonToBuffers` (T4), `createTreeRenderer` (T5), `hashSeed` (T1).

- [ ] **Step 1: Move the maturity store and write the failing page test**

```bash
git mv src/lib/fractal/maturity.ts src/lib/tree/maturity.ts
```

```tsx
// src/pages/__tests__/MemoryLayersPage.test.tsx  (replace fractal-era assertions)
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import MemoryLayersPage from '../MemoryLayersPage';

// jsdom has no WebGL2 — renderer returns null → fallback path renders.
describe('MemoryLayersPage (tree)', () => {
  it('renders the WebGL2 fallback message when no GL context is available', () => {
    const { getByText } = render(<MemoryLayersPage />);
    expect(getByText(/WebGL2 unavailable/i)).toBeTruthy();
  });

  it('does not import any fractal modules', async () => {
    const src = await import('../MemoryLayersPage?raw').then((m) => m.default).catch(() => '');
    expect(src).not.toMatch(/lib\/fractal\/(organism|escape|breathing|signal)/);
  });
});
```

> If `?raw` import is unavailable in the vitest config, replace the second test with a Node `fs.readFileSync` read of the file path and the same regex assertion.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/pages/__tests__/MemoryLayersPage.test.tsx`
Expected: FAIL — page still imports fractal modules / fallback text mismatch.

- [ ] **Step 3: Rewire the page to the tree pipeline**

In `src/pages/MemoryLayersPage.tsx`:

1. Replace the fractal imports with:
```tsx
import { deriveTreeState } from '@/lib/tree/treeState';
import { generateSkeleton } from '@/lib/tree/skeleton';
import { skeletonToBuffers } from '@/lib/tree/geometry';
import { createTreeRenderer, type TreeRenderer } from '@/lib/tree/renderer';
import { hashSeed } from '@/lib/tree/rng';
import { maturity } from '@/lib/tree/maturity';
import type { TreeInput } from '@/lib/tree/contract';
```

2. Replace the renderer ref/effect:
```tsx
const rendererRef = useRef<TreeRenderer | null>(null);
const seedRef = useRef<number>(hashSeed('feral-tree-v1'));

useEffect(() => {
  const canvas = canvasRef.current;
  if (!canvas) return;
  const r = createTreeRenderer(canvas);
  rendererRef.current = r;
  return () => { r?.dispose(); rendererRef.current = null; };
}, []);
```

3. Replace the state-derivation + draw path (where the page previously called `deriveOrganismState` + `render`). Build `TreeInput` from the existing graph pull, then:
```tsx
const renderTree = useCallback((input: TreeInput) => {
  const r = rendererRef.current;
  const canvas = canvasRef.current;
  if (!r || !canvas) return;
  const { state, floor } = deriveTreeState(input);
  maturity.save(floor);
  const skel = generateSkeleton(state, seedRef.current);
  const buffers = skeletonToBuffers(skel);
  r.draw(buffers, { aspect: canvas.clientWidth / canvas.clientHeight });
}, []);
```

4. Where the page builds the organism input from `graph.nodes`, adapt field names to `TreeInput` (`clusterCount`, `eliteNodeCount`, `rsi: rsiStatus ? { iteration, boundsVersion } : null`, `persistedFloor: maturity.load()`, `clusters`), and call `renderTree(input)` instead of the old render.

5. Remove all pan/zoom handlers (`onWheel`, drag `onPointer*`, `DEFAULT_VIEW`, `screenToComplex`) and the breathing RAF effect — Phase 1 is a fixed portrait. Keep the canvas element, the `aria-label="Refresh organism"` refresh button (re-pull + `renderTree`), and the WebGL2-unavailable fallback `<p>WebGL2 unavailable — organism view disabled.</p>`.

- [ ] **Step 4: Delete the fractal modules and run the grep audit**

```bash
git rm src/lib/fractal/organism.ts src/lib/fractal/escape.ts src/lib/fractal/breathing.ts src/lib/fractal/signal.ts src/hooks/useOrganismImpulse.ts
git rm -r src/lib/fractal/__tests__
```

Run the audit (expect no matches):
```bash
grep -rnE "lib/fractal/(organism|escape|breathing|signal)|deriveOrganismState|useOrganismImpulse|multibrot|escapeTime" src/ ; echo "exit: $?"
```
Expected: no output (grep exit 1). If `src/lib/fractal/` is now empty, remove the dir.

- [ ] **Step 5: Run the full frontend test suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests PASS, tsc clean. Fix any dangling fractal references tsc surfaces.

- [ ] **Step 6: Manual verification in the app**

Launch the app, open the Memory Layers page. Confirm: an ember-oak renders (dark trunk, amber→orange leaves on near-black); empty state shows a small sapling; the tree shape changes with memory/RSI state; no console errors. (Use the project `run` skill / `cargo tauri dev`.)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(tree): rewire MemoryLayersPage to tree pipeline; remove Mandelbrot viz"
```

---

## Self-Review notes

- **Spec coverage:** removal checklist (T6), treeState mapping (T2), deterministic skeleton + monotonic growth (T3), geometry (T4), thin renderer + null contract (T5), reused maturity floor (T2/T6), genesis sapling (T2/T6 manual). Engine escape-time explicitly out of scope (Global Constraints). ✓
- **Animation/impulses/click-inspect** are correctly absent (Phase 2/3).
- **Type consistency:** `TreeInput` (T1) → `deriveTreeState` (T2) → `TreeState` → `generateSkeleton` (T3) → `Skeleton` → `skeletonToBuffers` (T4) → `TreeBuffers` → `TreeRenderer.draw` (T5). Names align across tasks.
