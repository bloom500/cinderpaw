# Organism Tree — Phase 1: Static Reactive Tree (design)

Date: 2026-06-24
Branch: `feat/organism-tree`
Status: approved (brainstorming), pending plan

## Context & vision

The memory/RSI organism is currently rendered as a WebGL2 escape-time
**Mandelbrot** fractal (`frontend-react/src/lib/fractal/`). We are
replacing the fractal *visual* with a **realistic ember-oak tree** that
consumes the **same reactive data contract**. The Mandelbrot maths is
retired; the data signal (memory clusters + RSI maturity) stays.

Rendering approach (decided): **procedural 2.5D WebGL2** — generate a
branch skeleton procedurally from the contract, render branches as
shaded ribbons and leaves as instanced lit billboards in the existing
WebGL2 canvas. No heavy 3D dependency (no Three.js). Art direction:
**"Feral ember oak"** — dark textured bark, amber→orange foliage
embering on near-black, on-brand (black + orange).

### Scope boundary (IMPORTANT)

- **In scope (remove):** the *frontend* Mandelbrot visualization only —
  `frontend-react/src/lib/fractal/{organism,escape,breathing}.ts` and the
  fractal-specific parts of `signal.ts`, plus `useOrganismImpulse` and
  the fractal tests.
- **Out of scope (KEEP):** the *engine-side* escape-time mechanism
  (`FeralAgent/src/rsi/escape-time*.ts`, `fractal.ts`). That is internal
  RSI **selection pressure**, not the visualization. Removing it would
  change RSI behavior. It stays untouched.

### Phasing (this spec covers Phase 1 only)

1. **Phase 1 — Static reactive tree** (this spec): remove Mandelbrot,
   render a *still* ember-oak derived from the contract; framed portrait.
   No animation, no impulses, no click-to-inspect.
2. **Phase 2 — Life + impulses:** power-aware idle wind, recall
   sway/glow, seed bud-sprout, prune leaf-fall.
3. **Phase 3 — Interaction + polish:** click-to-inspect branch → cluster
   focus, bark/leaf texturing polish, growth-ring on `bounds_version`.

Each phase gets its own spec → plan → implementation.

## Goal of Phase 1

Given the live `OrganismInput` (memory clusters + RSI state), render a
static, recognizable ember-oak whose **shape encodes the data** and whose
**maturity never visually regresses**. Replace the Mandelbrot canvas in
`MemoryLayersPage` end-to-end with no dead code left behind.

Success criteria:
- The fractal viz files are deleted; nothing imports them.
- The tree renders from real memory/RSI state in `MemoryLayersPage`.
- Growth is **monotonic**: a higher persisted maturity floor never
  produces a smaller/shorter tree.
- Branch and leaf counts are **deterministic** functions of the contract
  (same input ⇒ same tree), so redraws are stable.
- WebGL2-unavailable path shows the existing graceful fallback message.

## Architecture (small, isolated, testable units)

All heavy logic is **pure** and unit-tested; the WebGL renderer is a thin
adapter (render output itself is not unit-tested — the pure stages are).

### `lib/tree/treeState.ts` — contract → tree parameters

Reuses the existing data contract shape (`OrganismInput`: `clusterCount`,
`eliteNodeCount`, `rsi`, `persistedFloor`, `clusters`). Pure.

```ts
export interface TreeState {
  /** Trunk height in normalized units (0..1 of canvas height). Driven by
   *  the monotonic maturity floor — never decreases for a given floor. */
  trunkHeight: number;
  /** Trunk base half-width (taper origin). Grows with maturity. */
  trunkGirth: number;
  /** Number of primary limbs off the trunk = memory cluster count,
   *  clamped to [MIN_LIMBS, MAX_LIMBS]. */
  primaryLimbs: number;
  /** Branch recursion depth. Grows with maturity (deeper = older). */
  depth: number;
  /** Target leaf count ∝ surviving (elite) node count, clamped. */
  leafCount: number;
  /** Per-limb angular bias from cluster positions (warpSeeds analogue),
   *  so limbs lean toward where memory actually clusters. */
  limbBias: number[];
}

export interface DerivedTree {
  state: TreeState;
  /** New monotonic floor to persist (>= input.persistedFloor). */
  floor: number;
}

export function deriveTreeState(input: OrganismInput): DerivedTree;
```

Mapping (Phase 1):
- `floor = max(persistedFloor, A*rsi.iteration + B*bounds_version)` —
  identical monotonic-floor rule as today's `maturity` store; reused.
- `trunkHeight`, `trunkGirth`, `depth` are increasing functions of
  `floor` (saturating, so a very old tree doesn't run off-canvas).
- `primaryLimbs = clamp(clusterCount, MIN_LIMBS, MAX_LIMBS)`.
- `leafCount = clamp(round(k * eliteNodeCount), 0, MAX_LEAVES)`.
- `limbBias[i]` derived from `clusters[i]` angle (empty ⇒ symmetric fan).

### `lib/tree/skeleton.ts` — parameters → branch graph (deterministic)

```ts
export interface Segment {
  x0: number; y0: number; x1: number; y1: number; // canvas-normalized
  width0: number; width1: number;                 // tapered
  depth: number;                                   // 0 = trunk
}
export interface Leaf { x: number; y: number; size: number; angle: number; clusterId: number }
export interface Skeleton { segments: Segment[]; leaves: Leaf[] }

export function generateSkeleton(state: TreeState, seed: number): Skeleton;
```

- Recursive/space-colonization growth with a **seeded deterministic RNG**
  (same `seed` + `state` ⇒ identical skeleton). `seed` is stable for a
  given install (derived once), so the tree's *identity* persists.
- Trunk → `primaryLimbs` limbs (angles fanned + `limbBias`) → recursive
  child branches to `state.depth`, each tapering in width.
- Leaves attached to terminal segments until `state.leafCount` placed.
- **Monotonic-growth invariant:** increasing `trunkHeight`/`depth` only
  *adds/extends* structure; existing segments keep their positions
  (growth is append-only relative to the previous, smaller state).

### `lib/tree/geometry.ts` — skeleton → GPU buffers

```ts
export interface TreeBuffers {
  branchPositions: Float32Array; // triangle ribbons per segment
  branchShade: Float32Array;     // per-vertex AO/depth shade
  leafInstances: Float32Array;   // [x,y,size,angle] per leaf (instanced)
  branchVertexCount: number;
  leafInstanceCount: number;
}
export function skeletonToBuffers(skel: Skeleton): TreeBuffers;
```

Pure array transform — testable on buffer shape/counts without a GL context.

### `lib/tree/renderer.ts` — WebGL2 adapter (thin)

```ts
export interface TreeRenderer {
  draw(buffers: TreeBuffers, view: TreeView): void;
  resize(): void;
  dispose(): void;
}
export function createTreeRenderer(canvas: HTMLCanvasElement): TreeRenderer | null;
```

- Two passes: **bark** (shaded ribbons, dark→warm rim) and **leaves**
  (instanced billboards, amber→orange gradient, alpha-tested leaf shape).
- Near-black background + soft ground shadow + vignette.
- Returns `null` when WebGL2 is unavailable (caller shows fallback) —
  same contract as `createOrganismRenderer` today.
- **No animation loop in Phase 1** — draws on demand (mount / state
  change / resize).

### `pages/MemoryLayersPage.tsx` — rewire

- Swap `createOrganismRenderer` → `createTreeRenderer`; `deriveOrganismState`
  → `deriveTreeState` → `generateSkeleton` → `skeletonToBuffers` → `draw`.
- Keep the existing data pull (graph nodes → `eliteNodeCount` /
  `clusterCount`) and the maturity-floor persistence.
- Remove pan/zoom handlers (Phase 1 is a fixed framed portrait; navigation
  returns in Phase 3 as click-to-inspect). Keep the refresh affordance.

## Data flow

```
memory graph + RSI status
  → OrganismInput  (unchanged contract; built in MemoryLayersPage)
  → deriveTreeState  → { TreeState, floor }   (+ persist floor, monotonic)
  → generateSkeleton(state, installSeed)  → Skeleton   (deterministic)
  → skeletonToBuffers  → TreeBuffers
  → TreeRenderer.draw  → WebGL2 canvas (static ember oak)
```

## Removal checklist

- Delete `lib/fractal/{organism,escape,breathing}.ts` and their `__tests__`.
- Delete `hooks/useOrganismImpulse.ts` (impulses return in Phase 2 as
  `useTreeImpulse`).
- `signal.ts`: keep `OrganismInput` (the data contract) — move it to
  `lib/tree/contract.ts` (or re-export) and delete the fractal-specific
  `OrganismState` / `WarpSeed` / `deriveOrganismState`. `maturity.ts`
  floor store is reused (renamed key comment only; value semantics same).
- Remove fractal imports/usages from `MemoryLayersPage.tsx`.
- `grep` audit: no remaining references to `fractal/organism`,
  `escapeTime`, `multibrot`, `power`/`morph` viz params in the frontend.

## Testing strategy

Pure stages carry the tests (the render adapter stays thin on purpose):

- `treeState`: branch count = clamped clusterCount; leafCount ∝
  eliteNodeCount; **floor monotonic** (floor never < persistedFloor;
  higher iteration ⇒ ≥ height); empty clusters ⇒ symmetric `limbBias`.
- `skeleton`: **determinism** (same state+seed ⇒ deep-equal skeleton);
  **monotonic growth** (state with larger maturity ⊇ smaller one's trunk
  position/segment count never shrinks); leaf count placed == target
  (within terminal capacity); depth respected.
- `geometry`: buffer lengths match segment/leaf counts; ribbon has 6
  vertices/segment; leaf instance stride == 4.
- `MemoryLayersPage`: renders without crashing on empty state (genesis
  sapling) and on populated state; WebGL2-null path shows fallback.

Render correctness (visual fidelity) is verified manually via the running
app, not unit tests.

## Out of scope (Phase 1)

- Idle wind / any animation loop (Phase 2).
- seed / recall / prune impulses (Phase 2).
- Click-to-inspect, camera focus, pan/zoom (Phase 3).
- Bark/leaf texture art polish, growth rings (Phase 3).
- Engine-side escape-time selection (never in scope — stays).

## Genesis / extremes

- **Empty state** (no memories, iteration 0): a small **sapling** — short
  trunk, few/no leaves — so onboarding shows "your tree starts here"
  rather than a blank canvas (supports zero-friction onboarding).
- **Mature state:** saturating curves cap trunk height/depth so a
  long-lived tree fills the frame handsomely without overflowing.
