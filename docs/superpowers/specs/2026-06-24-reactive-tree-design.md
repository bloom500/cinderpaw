# Reactive Pixel Tree — Memory Visualization Design

**Date:** 2026-06-24
**Status:** Approved (brainstorming)
**Supersedes (as the live skin):** the Mandelbrot organism on the Memory Layers page
(`2026-06-22-mandelbrot-organism-bulletproof-design.md`). The Mandelbrot code stays in
git, recoverable, but is removed from the UI.

## Why

Darius pivoted the Memory Layers visualization from a Mandelbrot organism to a **reactive
pixel-art tree**. The Mandelbrot was spectacular but too mathematically fragile for a
non-technical product vision (the ugly power 3–4 "valley", deep-zoom f64, domain-warp).
A tree maps **1:1 to the real substrate**: the RAPTOR tree (`root.children`, `LeafStore`,
`leaves()`). Clusters = branches, memories = leaves, and the reactive pulses
(`grow`/`seed`/`recall`/`prune`) already flowing from Fractal Memory Search are exactly
the right contract — the tree consumes them the same way the Mandelbrot did.

The tree must **feel alive**: a non-technical user looks at it and intuitively reads how
trained / stable / "smart" the local agent is, without a word of text — and sees the agent
think (recall lights a path) and learn (a write sprouts a leaf).

## Decisions (fixed in brainstorming 2026-06-24)

1. **Style:** pixel-art, matched to the Feral mascot (8-bit, black + orange palette).
2. **Leaf = cluster, zoom reveals memories** (LOD over RAPTOR levels). Far zoom: one leaf
   cluster per top-level RAPTOR cluster (countable). Zoom into a branch: the cluster leaf
   unfolds into its real member memories.
3. **Reactive choreography:** `seed` → new leaf pop-in; `grow` → new branch grows; `recall`
   → traversed path lights up; `prune` → leaf blackens and falls. (`prune` is a **new**
   sidecar event — does not exist today.)
4. **Idle:** fine ambient sway. This intentionally overrides the old Mandelbrot "no idle
   animation, user-driven only" constraint — Darius explicitly wants it alive at rest.
   Pixel sway on Canvas2D is cheap.
5. **Replace Mandelbrot completely** on the Memory Layers page. Reuse `signal.ts` /
   `maturity.ts` / `breathing.ts` as the signal-derivation layer.
6. **Scope:** all in one pass, including the backend additions (`prune` event + drill-down
   IPC), structured so the living tree works even if drill-down lands last.

## Rendering Approach — Canvas2D immediate-mode (chosen)

A single `<canvas>` draws trunk + branch segments + leaf sprites each frame. RAF runs only
during sway and active pulses. Pixelation via integer scaling + `image-rendering: pixelated`.
Click hit-testing via stored leaf rectangles.

Rejected: DOM/SVG sprites (thousands of elements → DOM bloat, janky sway); WebGL2 instanced
sprites (reintroduces exactly the complexity the pivot fled; overkill once LOD bounds the
sprite count).

LOD keeps on-screen sprite counts small (leaves = clusters at far zoom), so Canvas2D is more
than sufficient and the easiest to maintain.

## Architecture & Data Mapping (RAPTOR → tree)

**Deterministic layout, not centroid scatter.** The projected centroids (`clusters[].x/y`)
look random for a tree. Instead: a central trunk → branches that fan out recursively
(pixelated L-system). The **cluster identity** (stable index / hash) seeds the branch angle,
so a cluster's branch stays put across rebuilds. `weight` (= memory count) drives branch
**thickness + length** and **how many leaves** it carries.

**RAPTOR levels = zoom levels (LOD):**
- **Far zoom:** trunk + one branch per top-level cluster (`root.children`), each with a leaf
  crown whose density = the cluster's `leafCount`. Countable.
- **Zoom into a branch:** the branch subdivides → sub-branches/leaves = the cluster's real
  member memories (needs the drill-down IPC below).

**Reused signal layer.** `signal.ts` / `maturity.ts` / `breathing.ts` remain as the
derivation layer but are reinterpreted for the tree:
- `maturity.floor` (monotonic) → the minimum number of branches/leaves that never disappear
  again (the tree never "unlearns" below the maturity it has reached).
- `eliteNodeCount` → crown density.
- `power` / `warpSeeds` / Julia `morph` (Mandelbrot-specific) retire.

**New frontend files:**
- `lib/tree/layout.ts` — cluster → branch/leaf geometry, deterministic.
- `lib/tree/render.ts` — Canvas2D draw + pixel sprites.
- `lib/tree/sprites.ts` — leaf / trunk pixel art, black + orange mascot palette.
- `lib/tree/signal.ts` — reused/adapted from `lib/fractal/signal.ts` (tree interpretation).

`MemoryLayersPage.tsx` is rewritten to mount the tree instead of the organism. `organism.ts`
and the `lib/fractal/*` Mandelbrot renderer stay in git, removed from the UI.

## Reactive Choreography

Consumes `onFractalActivity` (`recall` / `grow` / `seed`) plus the new `prune`.

- **`seed` → new leaf pop-in:** a leaf appears with a short scale-up (~250ms) + orange
  sparkle on its cluster's branch (`leafId` → cluster via the payload mapping).
  Self-terminating RAF, like today's `breathing`.
- **`grow` → new branch grows:** rebuild with increased `clusterCount` → a new branch
  extends from the trunk (~600ms growth), the crown re-flows to the new layout derived from
  `clusters[]` / `leafCount`. Eased from old geometry to new (like today's `impulseTo`).
- **`recall` → path lights up:** the "touched" branch/leaves pulse orange briefly, then fade.
  Today `recall` carries only `hits` (a count), not *which* leaves — so step 1 lights the
  highest-density branches in proportion to `hits` (an approximation of "where it searched").
  Exact per-leaf lighting is a follow-up (would require `recall` to carry leafIds).
- **`prune` → leaf falls:** the leaf blackens and falls with short gravity (~500ms), then
  disappears — but the crown never drops below `maturity.floor`.
- **Idle → ambient sway:** a continuous, very cheap RAF (small-amplitude sinusoid on leaf
  offsets). The only permanent animation; pulses overlay on top of it.

## Backend Additions (sidecar TS)

1. **`prune` event.** Extend the `FractalActivity` union with
   `{ kind: "prune"; leafId: number; clusterIndex?: number }` in `fractal-memory.ts`, and
   `FractalActivityLine.kind` in `frontend-react/.../events.ts`.
   **Real prune source:** on rebuild, if a leaf that was in the tree disappears from the
   `#cappedLeaves()` set (cap eviction / deleted memory), emit `prune` for it (before/after
   rebuild diff). This is the only real prune that exists today — no fabricated trigger.

2. **Drill-down IPC `fractal_cluster_leaves`.** Request→response over stdin/stdout (the
   existing `rsi_start` ack pattern), returning `{ leafId, text, ts }[]` for a given cluster
   → feeds zoom-reveal + the card. A thin Rust `invoke` command forwards the request to the
   sidecar.

## Interaction (LOD + card)

- Pan / zoom preserved (reuse the logic from `MemoryLayersPage`).
- Click a leaf → minimalist Swiss card (black, orange accent) with the memory text (from the
  drill-down IPC).
- Deep zoom on a branch → the cluster leaves unfold into the real member-memory leaves
  (lazy-loaded via the same IPC, once per cluster).

## Testing & Gates

- **Frontend (vitest/jsdom):** `layout.ts` deterministic (same input → same geometry; larger
  `weight` → thicker branch / more leaves); signal/maturity reducers (monotonic floor); each
  pulse reducer (seed adds a leaf, prune respects floor). Canvas2D draw is not pixel-tested in
  jsdom — visual confirmation stays with Darius (`run-app-ui.bat`), as with Mandelbrot.
- **Sidecar (bun test):** `prune` emitted correctly on rebuild diff; `fractal_cluster_leaves`
  returns the right leaves; `grow`/`seed` unchanged (non-regression).
- **Gates:** `tsc` clean; frontend + sidecar suites green; then rebuild the sidecar `.exe` +
  copy to `src-tauri/binaries/` (otherwise `prune` / the IPC are not active — see the sidecar
  binary-flow note).

## Visual Smoke (Darius only, GPU)

Empty tree = trunk + bud, idle sway; write a memory = leaf pop-in; rebuild = branch grows;
recall = path lights up; prune = leaf falls but not below floor; click a leaf = card with the
text; zoom = unfold into member memories.

## Non-Goals

- Per-leaf exact recall lighting (needs `recall` to carry leafIds) — follow-up.
- Centroid-scatter positioning — explicitly rejected for a deterministic L-system layout.
- Keeping the Mandelbrot reachable in the UI — it lives in git only.
