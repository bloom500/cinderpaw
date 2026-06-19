# Memory Layers — Fractal Reskin + RSI UI Removal

**Date:** 2026-06-20
**Branch:** `feat/rsi-fractal-memory` (worktree `D:/FeralLocalAI/.worktrees/wt-29286b1b`)
**Status:** Approved design — pending spec review before implementation plan.

## Summary

This closes Faza 4 of the RSI Fractal Memory plan, but redirected from the
plan's literal target. Instead of replacing the RSI control panel with a
Mandelbrot view of the *genome population*, we:

1. **Delete the RSI control surface entirely** (`Fractal Memory` tab +
   `RsiPage`). The RSI + Fractal Search engine keeps running **passively** in
   the background, exactly like the old memory system — no user-facing control
   panel. (`passive-supervisor.ts` already auto-starts the engine on boot when a
   real model is configured.)
2. **Reskin the knowledge-graph tab** (`Memory Graph` → **`Memory Layers`**):
   replace the flat `vis-network` rendering with a theme-aware **WebGL2
   Mandelbrot** backdrop, with the existing knowledge-graph nodes laid over it as
   luminous "layers." Data is unchanged — same `getGraph()` snapshot.
3. **Move the RSI spend cap into Settings** so users set their own budget and we
   never silently burn cloud money. Default is **local-only ($0 cloud cap)**.

The deviation from the plan is intentional: the user owns this product surface
and chose the knowledge graph (real memory) as the thing worth visualizing,
with RSI demoted to a fully invisible background process.

## Non-Goals (YAGNI)

- No `rsi_population_update` stream. The genome population is **not** visualized;
  RSI is invisible. (The plan's PCA/lineage-trail/escape-time-of-genomes
  machinery is dropped for this surface.)
- No RSI start/stop/goal/concurrency UI anywhere. The engine self-manages.
- No new graph *data* — the fractal is a new *encoding* of the existing
  `MemoryGraphSnapshot`, not a new backend.

---

## Section 1 — Remove the RSI control surface

**Delete:**
- `frontend-react/src/pages/RsiPage.tsx`
- `frontend-react/src/pages/__tests__/RsiPage.test.ts`
- The `Fractal Memory` nav item in `Sidebar.tsx` (the `CircuitBoard` / `rsi`
  entry) and the `'rsi'` member of `MenuAction`.
- The `/rsi` route + lazy `RsiPage` import in `router.tsx`.

**Keep / verify:**
- `passive-supervisor.ts` and the whole sidecar RSI engine — **untouched**. The
  engine runs headless.
- `RsiEngineEventLine` in `lib/tauri/events.ts`: after `RsiPage` is gone its only
  consumer is gone. Remove the now-dead interface (and the `rsi_engine_event`
  parsing note) **only if** a repo-wide search confirms no other importer; the
  Rust-side `handle_rsi_engine_event` audit interception is independent and
  stays. If anything else references it, leave it.
- Tauri `rsi.*` commands (`rsi_status`, `rsi_start`, etc.): left in place. They
  are harmless without a UI and the passive supervisor / future debug tooling may
  still call them. Removing them is out of scope.

**Acceptance:** App builds, no dead imports, no broken route; navigating the app
never surfaces an RSI control. Engine still autostarts passively on boot (existing
behavior, unchanged).

## Section 2 — RSI spend cap in Settings

**Problem:** Passive mode today runs with effectively-unbounded caps
(`FERAL_RSI_MAX_ITER` default 100k, `FERAL_RSI_MAX_TOKENS` default 1e9) read from
env in `passiveStartOptions()`. There is **no USD spend cap**. On a cloud provider
this could burn real money silently.

**Design:**
- Add a **"RSI background budget"** control to `SettingsPage`, persisted with the
  existing settings mechanism (same store/persistence other settings use).
- Semantics: a **maximum USD spend cap** for the passive RSI engine.
  - **Default: `$0` = local-only.** At `$0` the passive engine may run on local
    models (which cost nothing) but must **not** spend on cloud providers. The UI
    copy states plainly: *"Local models are free; this cap only limits cloud
    spend. 0 = never spend cloud money."*
  - User can raise it to opt into a bounded cloud spend.
- **Wiring:** the Settings value flows to the sidecar passive engine as its cost
  cap, feeding the existing `max_total_cost_usd` / `cost_warning_ratio`
  substrate machinery (already surfaced in `rsi_status`) rather than the current
  unbounded token cap. Concretely: the value is passed into the sidecar env /
  passive start options (e.g. a `FERAL_RSI_MAX_COST_USD` knob) and enforced by the
  engine's existing budget guard. When the cap is reached the passive run ends
  (its normal stop path) and the supervisor's restart respects the same cap.
- A `$0` / local-only cap must hard-gate cloud-provider RSI calls — not merely
  warn — so the default can never spend.

**Acceptance:** Setting persists across restarts; with default `$0`, no cloud RSI
spend occurs (verifiable: cloud-provider RSI calls are gated off); raising the cap
allows bounded spend that stops at the cap.

## Section 3 — Rename + reskin: Memory Graph → Memory Layers

- `Sidebar.tsx`: label `Memory Graph` → **`Memory Layers`**. Keep the `Brain`
  icon (or swap if a better fit emerges during build — not load-bearing).
- `router.tsx`: route `/memory-graph` → `/memory-layers`. Add a redirect from the
  old path to the new so nothing breaks.
- Rename `MemoryGraphPage.tsx` → `MemoryLayersPage.tsx` (component
  `MemoryLayersPage`); update the lazy import and the `memoryGraph` →
  `memoryLayers` action id in `Sidebar.tsx`.
- **Data unchanged:** still `tauri.memory.getGraph()` →
  `{ nodes: {id,label,type,touched_at}, edges: {from,to,relation} }`.
- **Preserve the working chrome:** the floating control panel (search, the four
  type filter chips with counts, relation chips, show-labels toggle, node count),
  refresh button, selected-node detail card, empty/loading states. These wrap the
  new canvas instead of the `vis-network` one.

## Section 4 — Visual: theme-aware WebGL2 Mandelbrot

**Renderer:** a full-bleed `<canvas>` with a **raw WebGL2** context running a
Mandelbrot fragment shader (smooth/continuous escape-time coloring). No new
dependency (no three/regl) — consistent with the codebase keeping `vis-network`
code-split for bundle weight. A static fallback (or graceful "WebGL2 unavailable"
message) covers contexts without WebGL2.

**Theme palettes** (driven by `resolvedTheme`, matching the supplied references):

- **Light** — *"elephant / seahorse valley"* (Image 1): near-white lavender field
  (`~#eae8f2`), blue-violet → periwinkle filigree on the escape bands
  (`~#5b5fae`/`#9aa0e0`), black interior bulbs. Calm, airy, delicate.
- **Dark** — *"DESERT.ANGEL"* (Image 2): black interior/field, warm escape-band
  gradient **orange → amber → deep red → cream** (Feral brand orange at the
  core of the gradient), with a soft outer glow. Ember-like, on-brand.

Both palettes apply the same smooth-iteration coloring; only the gradient LUT and
background change with theme. Interior (in-set) points render as the field/black.

**Vector zoom & scalability (hard requirement):**
- The Mandelbrot is **resolution-independent**: the fragment shader recomputes
  every pixel at the current zoom/center each frame, so zooming **never loses
  quality / never pixelates** — unlike zooming a raster image. User zoom (wheel /
  pinch) and pan adjust shader uniforms (`center`, `scale`), not a stored bitmap.
- Nodes scale as **vector** too: glows are drawn via SDF/Canvas2D vector
  primitives at device-pixel resolution (honor `devicePixelRatio`), so orbs and
  edges stay crisp at any zoom and on HiDPI displays.
- **Scale target: ~1000+ memory nodes without quality or perf loss.** Approach:
  - Node positions from the seeded layout are in world space; only screen
    projection changes on zoom (no relayout while zooming).
  - **Level-of-detail (LOD):** labels and faint edges fade out when zoomed far
    out or when node density is high; they fade back in on zoom-in / hover. The
    fractal and node orbs always render; only text/edge clutter is culled.
  - Node draw stays cheap at 1000+ (batched 2D draw or instanced points); avoid
    per-frame physics — layout is computed once per snapshot, not per frame.
- **Precision boundary (honest limit):** WebGL2 `float` (fp32) supports deep but
  not infinite zoom; extreme deep-zoom eventually shows fp32 banding. For a
  UI-level backdrop with bounded auto-drift + interactive zoom this is well within
  range and not a concern. If true astronomical deep-zoom is ever wanted it needs
  fp64-emulation / perturbation — explicitly out of scope here.

**Motion (the "alive" feel):** a slow, continuous auto-drift/zoom of the fractal
parameters (bounded, looping) so the backdrop breathes. Subtle — it must not
distract from the nodes or cause motion sickness; respects
`prefers-reduced-motion` (freezes to a static frame when set).

**Nodes as "layers" over the fractal:**
- Node 2D positions come from a **seeded deterministic layout** (reuse the same
  seeded force-style placement the current page relies on, computed in JS once per
  snapshot — not physics-on-every-frame), so the graph is stable across reloads.
- Nodes render as **glowing orbs** composited above the fractal canvas:
  - **size** = degree (hubs read larger), as today.
  - **hue** = node `type` (entity/concept/event/fact), using the existing
    per-theme type palette so the legend chips still match.
  - **brightness/glow** = degree (importance), echoing the references' luminous
    spiral eyes.
- **Edges** = faint trails between related nodes (relation label on hover), low
  opacity so the fractal reads through — like the lace filigree connecting forms
  in the references.
- **"Layers"** = depth/parallax: the fractal backdrop sits behind, nodes float
  above with a slight parallax against the auto-drift, giving a sense of zooming
  *through* memory layers. (Naming rationale for "Memory Layers.")

**Interaction preserved:** hover tooltip (label + type), click → selected-node
detail card with neighbors, search highlight/filter, type filters, refresh — all
identical in behavior to today; only the rendering layer changes.

**Composition options considered:**
- (A, chosen) Two stacked canvases: WebGL2 Mandelbrot backdrop + a 2D node/edge
  overlay (Canvas2D or SVG) for nodes. Simplest, keeps interaction hit-testing in
  familiar 2D, isolates the shader. Recommended.
- (B) Everything in WebGL2 (nodes as instanced point sprites). Prettier glow, but
  hit-testing + label layout in WebGL is heavy for the payoff. Deferred.

## Architecture / isolation

- `MemoryLayersPage` (page): data fetch, filters, selection, chrome — same shape
  as today.
- `MandelbrotCanvas` (new component): owns the WebGL2 context, shader, palette
  (theme prop), and auto-drift loop. Pure renderer — props in, no app knowledge.
- Node overlay: a focused component/layer that takes laid-out nodes + edges and
  handles draw + hit-testing. Testable independently of the shader.
- Seeded layout: a pure function `layout(snapshot) -> positions`, unit-testable.

## Testing

- Unit: seeded layout is deterministic (same snapshot → same positions); palette
  selection by theme; node→screen projection math.
- Smoke: page mounts with empty graph (empty state), with a small graph (nodes
  render), and `prefers-reduced-motion` freezes the drift.
- Regression: removing `RsiPage` leaves no dead imports; old `/memory-graph`
  redirects to `/memory-layers`.
- Scale/zoom: render a synthetic ~1000-node snapshot — verify interactive frame
  rate holds, zoom stays crisp (no pixelation), and LOD culls labels/edges at low
  zoom and restores them on zoom-in.
- WebGL is hard to assert pixel-wise in unit tests; cover the shader path with a
  context-creation guard + fallback test, and verify visually in the running app.

## Open decisions (flag during build, not blockers)

- Exact gradient LUTs / drift speed — tuned visually against the references in the
  running app.
- Whether to keep the `Brain` sidebar icon or pick a fractal-flavored one.
- Final env knob name for the budget (`FERAL_RSI_MAX_COST_USD` proposed).
