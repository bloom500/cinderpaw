# Mandelbrot Organism — Bulletproof Design

**Date:** 2026-06-22
**Branch:** `feat/rsi-fractal-memory` (worktree `wt-29286b1b`)
**Status:** Approved (Darius, 2026-06-22) — ready for implementation plan
**Supersedes/refines:** `2026-06-20-fractal-memory-search-pivot.md` (Module 2 / Phase 3),
memory `project_mandelbrot_organism_vision`

---

## 1. Goal

Make the "Memory Layers" Mandelbrot organism **visibly evolve from real RAPTOR
data**, smoothly and live, and make it **robust** (no crashes, no permanent
black screen). It is the WOW-factor visual for the pitch (YC/NVIDIA): you look
at the fractal and *feel* the local agent's memory growing — without a word of
text on screen.

**New user:** a perfect cardioid (power 2), no branches.
**As memory accumulates:** fractal structure grows **smooth and live**.
**On extinction (prune / RSI death):** structure retracts smoothly toward a
permanent floor — the agent never visually "forgets" the maturity it earned.

## 2. Core decisions (locked during brainstorming)

1. **Single evolving Mandelbrot organism**, NOT a network of mini-fractals.
   The "infinite spider-web at hundreds of thousands of memories" feeling comes
   from **iteration depth + domain-warp + infinite boundary zoom** — NOT from
   raising the power. (Multibrot power saturates visually ~8 and degenerates to
   a scalloped disc beyond that; it is a *coarse shape* signal only.)

2. **Power is a small coarse signal, not the infinity driver.** Genesis = 2.
   Rests only at 2 or ≥~4.5 (never parks in the "ugly valley" 3–4 that Darius
   rejected — the doubled blob #3). Cap ≈ 5. Transitions between rest states are
   smooth eased animations (~1.5 s) that *do* sweep through 3–4, but only **in
   motion** ("the agent is learning"), never frozen there.

3. **Real data, not the proxy.** Today the page derives `clusterCount` from
   `new Set(node.type).size` and `eliteNodeCount` from `graph.nodes.length` — a
   near-constant, logarithmic, near-imperceptible signal. We replace this with
   the real `grow` event payload (`clusterCount = tree.children.length`,
   `leafCount`, and projected cluster positions).

4. **The dominant growth channels are depth + warp**, which scale authentically
   to 100k+ memories; power is secondary.

## 3. Current state (verified in code 2026-06-22)

- `signal.ts`: `power = MANDELBROT_POWER` (locked 2, commit e99bc6e). `warpSeeds`
  computed from `input.clusters`, but the page **never passes `clusters`** →
  always `[]`.
- `organism.ts` (WebGL2 shader): has `u_power`, `u_morph`, `u_maxIter` — **but
  NO warp uniform and no domain-warp in `escape()`**. So warp is unrendered even
  if seeds existed. (The memory's claim "renderer knows to inflate at centroids"
  was stale — corrected here.)
- `MemoryLayersPage.tsx`: `grow` handler calls `void refresh()` which re-derives
  from the **proxy** and throws away the real `e.leafCount`/`e.clusterCount`.
- `fractal-memory.ts` (sidecar): already emits
  `grow {leafCount, clusterCount = tree.children.length}` and `recall {hits}`.
  **Centroids are NOT in the payload.**
- No WebGL context-loss handling → a lost context = permanent black screen.

## 4. Architecture & components

Data flows: **sidecar (TS) → agent-output JSON passthrough (Rust, untouched) →
`events.ts` → `MemoryLayersPage` → `signal.ts` → `organism.ts` shader.**

### 4.1 Sidecar (TypeScript — no Rust change)

- **New pure unit `projectCentroids(centroids: Float32Array[], seed=1) → {x:number,y:number}[]`.**
  Deterministic random projection (Johnson–Lindenstrauss: a fixed seeded
  384×2 Gaussian matrix), then normalize the resulting 2D points into a band
  around the Mandelbrot boundary (roughly x∈[-2, 0.6], y∈[-1.2, 1.2]). Pure,
  unit-tested, no model/IO. Lives next to `tree-builder.ts` in
  `FeralAgent/src/memory/fractal/`.
  - *Why random projection, not PCA:* O(n) cheap, stable with a fixed seed, and
    for ≤ a few hundred top-level clusters it preserves relative spread well
    enough that distinct topics land at distinct, stable positions. The goal is
    a believable organic layout, not a metric embedding.

- **Extend the `grow` activity** (`FractalActivity` in `fractal-memory.ts`):
  `{ kind: "grow"; leafCount; clusterCount; clusters: {x,y,weight}[] }` where
  `clusters[i]` = `projectCentroids(tree.children.map(c=>c.centroid))[i]` with
  `weight = tree.children[i].leafIds.length` (normalized 0..1 across clusters).

### 4.2 Event type (`frontend-react/src/lib/tauri/events.ts`)

- `FractalActivityLine` gains optional `clusters?: {x:number;y:number;weight:number}[]`.
  Rust forwards `feral://agent-output` verbatim, so no Rust change is needed —
  confirm by asserting the field survives the round-trip in a test/manual check.

### 4.3 Signal (`frontend-react/src/lib/fractal/signal.ts`)

- **Power mapping (new, replaces the hard lock):**
  `powerForClusters(n)` — piecewise/eased coarse signal:
  - `n ≤ T0` (e.g. 2 clusters) → **2.0** (Genesis / few topics: clean cardioid).
  - `n ≥ T0` → ease from a floor of **~4.5 up to a cap of ~5.0** as `n` grows
    (log-shaped so it climbs fast then saturates). **Never returns a rest value
    in (2, 4.5).** Easing between the old and new power happens in the impulse
    layer (`useOrganismImpulse`), so the 3–4 sweep is transient only.
  - Constants `POWER_CAP`, `POWER_VALLEY_LO=2`, `POWER_VALLEY_HI≈4.5`, `T0`
    exposed at top of file for tuning.
- **depthBoost more aggressive:** raise `REACTIVE_K` and/or switch the term so a
  growing corpus produces a *visible* density increase (target: a clearly
  denser boundary web between 10 and 10k leaves), while staying ≤ the 2048 iter
  clamp in the renderer.
- **warpSeeds:** keep current mapping but now actually fed `clusters` from the
  payload; `amp` scales with cluster weight, `sigma` ~0.12 baseline.
- Monotonic `floor` (lifetime maturity) unchanged — still `max(persistedFloor, …)`.

### 4.4 Page wiring (`MemoryLayersPage.tsx`)

- `grow` handler **no longer calls `refresh()`**. It derives the new state
  directly from the event payload (`clusterCount`, `leafCount`, `clusters`) +
  current RSI status + persisted floor, then `impulseTo(current, next)` for the
  smooth eased transition.
- `refresh()` (manual button + initial mount) keeps working as the
  pull-based path, but uses the real counts when a tree exists (one-time read);
  with no tree it yields the **Genesis cardioid** rest state.
- Initial/empty state = Genesis (power 2, depthBoost floor, warpSeeds []).

### 4.5 Renderer (`organism.ts` shader) — the missing visual piece

- Add warp uniforms: `u_warpCount` (int), `u_warpXY` (vec2[N]), `u_warpSA`
  (vec2[N] = sigma, amp). Pick a fixed max N (e.g. 32; clusters beyond N are
  dropped or merged by weight) to keep a static uniform array.
- In `escape()`, perturb the sampled point by a sum of Gaussian bumps:
  `c += Σ_i amp_i * gaussian(|c - seed_i|, sigma_i) * dir` — a domain-warp that
  bends the boundary outward near dense clusters → organic protrusions
  ("filaments / arms growing where memory is dense"). Tune so warp is subtle at
  rest and never destroys the recognizable Mandelbrot silhouette.
- Power/morph/depth uniforms already present and correct.

### 4.6 Atrophy

- When `clusterCount` / live nodes drop between states, `powerForClusters` and
  `depthBoost` produce **lower** targets; `impulseTo` eases the form down. Warp
  `amp`s shrink with cluster weight. The monotonic `floor` clamps the bottom —
  fine filaments retract, macro structure earned over lifetime stays. No text
  fade; pure structural retraction.

### 4.7 Robustness (bulletproof)

- **WebGL context loss:** add `webglcontextlost` (preventDefault) +
  `webglcontextrestored` (re-create renderer, redraw) listeners on the canvas.
  Today a lost context is a permanent black screen.
- **Defensive guards:** missing/empty/malformed payload → fall back to Genesis
  rest state, never throw. `projectCentroids([])` → `[]`. Clamp warp count.
- **No idle animation invariant preserved:** every RAF (impulse, breathing) is
  self-terminating and cancelled on unmount; GPU returns to 0% at rest.
- **WebGL2 unsupported:** existing graceful "organism view disabled" message.

## 5. Testing

Pure logic is unit-tested (WebGL/GPU is not available in jsdom, so the shader
itself is smoke-checked manually in-app, not in CI):

- `projectCentroids`: deterministic (same seed → same points), `[]` → `[]`,
  output points within the target complex band, distinct inputs → distinct
  outputs.
- `signal.ts`: Genesis (`n≤T0` → power exactly 2); **never returns a rest power
  in (2, 4.5)**; saturates at `POWER_CAP`; atrophy yields target ≥ floor and
  ≤ previous; warpSeeds derived 1:1 from provided clusters with weight→amp.
- `MemoryLayersPage`: `grow` event with `clusters` drives derive without the
  proxy (mock renderer); empty/no-tree → Genesis; context-loss handler
  re-creates the renderer (mock canvas/gl).
- Regression: existing `organism-signal`, `organism-projection`, `breathing`
  tests stay green (adjust expectations only where power-lock assumptions change).

## 6. Out of scope (deferred — kept on the list, not now)

- **Ghost cards** (click dense filament → Swiss card with memories at those
  complex coords) — needs `leafIds → coords` from the sidecar.
- **Mini-brot-per-terminal-cluster** rendering.
- **Embedding swap** (bge-large / bge-m3 for higher recall) — separate track;
  note bge-large-en is English-only, bge-m3 is multilingual (matches the RO
  corpus) if/when we pursue it.

## 7. Risks & mitigations

- *Power sweep through 3–4 looks bad even in motion* → easing is fast (~1.5 s)
  and warp+depth keep the form organic; if still jarring, shorten the dwell in
  (2, 4.5) by steepening the ease through that band.
- *Random projection clumps clusters* → fixed seed + normalization spread; if
  clumping is visible, fall back to a 2-component power-iteration PCA (still
  pure, slightly more compute) — a localized change to `projectCentroids` only.
- *Warp destabilizes the silhouette at high cluster counts* → cap warp count
  (N=32) and clamp total amplitude.
