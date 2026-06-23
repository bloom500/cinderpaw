# Mandelbrot Organism (from scratch) — Design Spec

**Date:** 2026-06-21
**Status:** Approved (brainstorming)
**Branch:** `feat/rsi-fractal-memory`
**Supersedes (evolves):** `2026-06-20-mandelbrot-generative-memory-design.md` (which used
text-on-filaments + a fixed Mandelbrot backdrop — both dropped here).
**Builds on:** `2026-06-20-fractal-memory-search-pivot.md` (RAPTOR tree = the data source).

## Summary

Rebuild the Memory Layers screen from scratch as a **pure generative organism**: a
custom, data-driven escape-time fractal whose *form is the agent's memory/RSI state*.
No text, no nodes, no inspection UI — you look at the fractal and read, from how
many arms it has and how baroque its filaments are, how matured and knowledgeable the
local agent is. It grows when the agent learns and atrophies when memory is pruned.

This is **not** the classic Mandelbrot set with data-driven render params (the prior
design). The iteration formula itself is parameterized by data, so the *shape* changes
with the agent, not just the depth/coloring.

## Non-Negotiables / Honest Limits

- **Vector zoom, no quality loss — within float32.** Escape-time is recomputed per
  pixel each draw, so pan/zoom stays crisp at any zoom *until* single-precision runs
  out (~`scale < 1e-5`), where blockiness appears. This is a hardware/math limit of
  32-bit floats in WebGL2, not a bug. Phase A accepts it (crisp through the organism's
  intended range). Emulated double precision (df64) or perturbation theory is a
  possible later upgrade, explicitly out of scope here.
- **No idle animation.** Idle = frozen, zero GPU. Motion happens only on discrete
  events (see Cadence).
- **Augment, never break.** The visualization reads existing data; it must render
  something sane before the RAPTOR tree / embedding model exist (graceful degradation).

## The Form — custom data-driven escape-time fractal

Per pixel, iterate:

```
z → z^d + c_warp
```

- **`d` — fractional power (≈2 → ≈8), from memory diversity.** Driven by the number of
  top-level RAPTOR clusters. `d≈2` (newborn) is a smooth disc / two-lobe; higher `d`
  is a many-armed baroque star (a multibrot of fractional order). The number of primary
  arms reads as the breadth of what the agent knows.
- **`c_warp = c + domainWarp(c)` — filaments from clusters.** `domainWarp` adds a sum of
  small Gaussian displacements centered at cluster positions (each cluster centroid
  projected to the complex plane by a fixed deterministic map). This bends the local
  field where memory concentrates, producing organic filaments/tendrils there —
  **without** destabilizing escape-time. (Rational/pole terms `Σ wᵢ/(z−pᵢ)` were
  considered and rejected: they turn the clean escape structure to mush and are hard to
  keep stable. Domain warping is stable and cheap.)
- **Iteration depth** = monotonic maturity `floor` (persisted, never decreases) +
  reactive volume from elite-node count → controls structural resolution / how deep
  filaments branch.

Fractional powers use the polar form: `z^d = r^d · (cos(d·θ), sin(d·θ))` with
`r=|z|, θ=atan2(z.y,z.x)` — a few extra GPU ops per iteration, still cheap.

### Phasing (engineering judgment, approved)

- **Phase 3a — solid:** the data-driven multibrot (fractional `d` + depth + breathing +
  extinction + the pure UI rewrite). Self-contained, deliverable, testable.
- **Phase 3b — experimental:** the cluster `domainWarp` filaments. Needs visual
  iteration; built and tuned separately on top of 3a so a tuning problem there can
  never block the solid base.

## Signal Mapping (`deriveOrganismState`, pure + tested)

```
input:  { clusterCount, eliteNodeCount, rsi: RsiStatus | null, persistedFloor,
          clusters: {x,y,weight}[] }   // clusters present only once a tree exists
output: { power, depthBoost, morph, warpSeeds: {x,y,sigma,amp}[] }
```

- `power      = clamp(2 + k_p · log2(1 + clusterCount), 2, 8)`
- `floor      = max(persistedFloor, a·highWater(rsi.engine.iteration) + b·boundsVersionStep)`
  — monotonic; persisted via the existing `maturity` store; reused unchanged.
- `depthBoost = floor + k_r · log2(1 + eliteNodeCount)` (reactive term clamped ≥ 0)
- `morph      = 0` at rest; an event impulse eases it up to ≤ 0.12 then back to 0.
- `warpSeeds  = clusters.map(project + weight→amp)` (Phase 3b; `[]` in 3a / pre-tree)
- **Graceful null:** `rsi == null` → its terms contribute 0; an empty tree → `power=2`,
  no warp seeds, depth from the persisted floor only (newborn look, never a crash).

## Cadence & Lifecycle (event-pulsed, self-settling)

- **Idle = frozen.** No `requestAnimationFrame` loop at rest.
- **Impulse on event** — an RSI iteration completing, a new memory ingested, or a user
  query — runs a single ~1.5 s ease-out `rAF` that animates from the previous
  organism-state to the new one (and a small `morph` blip), then `cancelAnimationFrame`.
  Reuses the existing `useFractalTransition` machinery. Frequent RSI iterations read as
  continuous, living motion; total idle costs nothing.
- **Growth** — between impulses, `power`/`depthBoost` step up as clusters/elite grow:
  arms appear, filaments deepen.
- **Extinction** — when memory is pruned or an RSI strategy dies, `power` and the
  reactive depth drop between snapshots → arms and filaments **physically retract**
  toward the trunk (atrophy), leaving an airier, more concentrated form. The persisted
  `floor` guarantees the organism never regresses below its earned lifetime baseline.

## Data Source & Graceful Degradation

- **Primary:** the RAPTOR tree (top-level cluster count → `power`; centroids → warp
  positions; depth → iterations) + `tauri.rsi.status()` for the maturity/impulse signal.
- **Before a tree exists** (no embedding model yet): fall back to the memory-graph node
  count for a coarse `power`/depth, no warp seeds. The organism still grows with usage;
  it just lacks per-cluster filaments until the tree is built.
- All reads are best-effort; any failure degrades to the newborn/coarse look, never a
  crash (mirrors the recall fallback contract).

## Architecture (isolated units)

- **`lib/fractal/organism.ts`** — NEW WebGL2 renderer with the custom shader
  (`z^d + c_warp`, fractional power, domain warp, smooth-iteration coloring, adaptive
  AA). Resolution-independent. Built from scratch — `mandelbrot.ts` is left untouched
  (it can be deleted once the page no longer imports it).
- **`lib/fractal/signal.ts`** — extend with `deriveOrganismState(...)` (pure, unit-
  tested). The existing `deriveFractalState` is replaced/retired.
- **`lib/fractal/maturity.ts`** — reused unchanged (monotonic floor).
- **`pages/MemoryLayersPage.tsx`** — rewritten to compose only the organism canvas +
  a discrete Refresh; all node/text/search/detail UI removed.
- **`hooks/useOrganismEvents.ts`** (or inline) — subscribes to RSI engine / memory
  events and triggers impulses.
- **Removed:** `components/memory/FilamentText.tsx`, and the node-overlay / selection /
  search / filter code in the page. `lib/fractal/{layout,diff}.ts` (node-placement
  helpers) likely become dead and are removed if so.

## Aesthetic

Cyberpunk, brand black + orange. Reuse and refine the existing dark palette
(red→orange→amber→cream by smooth iteration) with per-region iridescence. Interior =
near-black. This is the only palette; no light/dark node coloring (no nodes).

## Testing

- `deriveOrganismState` (pure): newborn → `power 2`, depth = floor only; `power` rises
  with clusterCount and is clamped to 8; `floor` is monotonic and survives a
  cluster-count drop; `rsi == null` → its terms 0, `morph` 0; extinction lowers
  reactive terms but never below `floor`; warpSeeds empty without clusters.
- `maturity` store: unchanged (existing tests).
- The shader is verified visually via `bun run` (frontend-only; no sidecar rebuild).
  WebGL2 unavailable → existing CSS flat-field fallback retained.

## Out of Scope

- Emulated double precision / perturbation-theory deep zoom (accept float32 limit).
- Any text/label/node rendering (permanently removed).
- Rational/pole-based deformation (rejected for instability; domain warp instead).
- Re-introducing node inspection — full purity is the chosen direction.
