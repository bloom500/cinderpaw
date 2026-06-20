# Mandelbrot as Generative Memory Art — Design

**Date:** 2026-06-20
**Status:** Approved (brainstorming)
**Supersedes (evolves):** `2026-06-20-memory-layers-fractal-design.md`
**Branch:** `feat/rsi-fractal-memory`

## Summary

Evolve the Memory Layers page from a *data visualization* (static Mandelbrot
backdrop + floating glow orbs) into *generative art bound to data*: a living
mathematical landscape whose structure, depth, and inhabited text grow and
recede with the agent's memory and RSI state.

The Mandelbrot stops being a fixed wallpaper. Its rendering parameters become
functions of the knowledge graph and the RSI engine. Memory nodes stop being
orbs floating *on top* of the fractal and instead become iridescent **text woven
along the fractal's filaments**. Node birth and extinction are visible events.

**Non-goals / honest limits:**
- This is **not** a photoreal offline 3D render (the Gemini reference image is
  Blender/Octane-class, minutes-per-frame, on invented data). We deliver a
  *stylized real-time evocation* of the same idea on the existing 2D canvas.
- No continuous/ambient animation. Every transition is **user-driven** (mount,
  Refresh). Idle = zero animation loops.

## The Lifecycle (UX narrative the design must deliver)

1. **Tabula Rasa (newborn):** empty DB → a smooth black disc in a minimal orange
   aura. No detail, no text, no noise. Stable, clean, ready to learn.
2. **Genesis (growth through dialogue):** as messages/tasks/RSI iterations
   accumulate, the disc sprouts bulbs and throws deep filaments outward; memory
   text writes itself *along* those filaments in lavender/amber iridescence;
   the first mini-Mandelbrots (isolated satellites) appear as dense knowledge
   nuclei / champion RSI genomes.
3. **Cataclysm (extinction & cleanup):** on user **Refresh** after a background
   elitist-extinction prune, whole filaments and their mini-Mandelbrots dissolve
   *en masse* — text fading character-by-character along the curves — and the
   landscape structurally simplifies into airy, refined branches.

## Architecture & Data Flow

Keep the two-layer composition (WebGL2 fractal at `z-0`, 2D node canvas at
`z-1`). Insert a **pure signal-derivation** stage between data and rendering.

```
tauri.memory.getGraph()  ┐
tauri.rsi.status()        ├─→ deriveFractalState()  ──→ FractalState
(read at mount/Refresh)   ┘        (pure, tested)         { depthBoost, morph }
                                                                 │
maturity floor (persisted, monotonic) ─────────────────────────┤
                                                                 ↓
prev snapshot + next snapshot ──→ transition controller (rAF, user-driven, auto-stop)
                                                                 ↓
                        ┌──────────────────────────────┬─────────────────────────┐
                        ↓                                ↓                         ↓
            MandelbrotCanvas.render(view,         FilamentText layer       lifecycle diff
            theme, fractalState)                  (replaces NodeOverlay)    (birth/extinction)
```

### Units (each independently testable)

- **`deriveFractalState(input): FractalState`** — pure function. No I/O, no DOM.
  - Input: `{ nodeCount, eliteNodeCount, rsi: RsiStatus | null, maturityFloor }`.
  - Output: `{ depthBoost: number, morph: number }`.
  - Home of *all* mapping logic. Fully unit-tested.
- **`maturity` store** — persists the monotonic floor (localStorage, per-install
  key). Exposes `current()` and `bump(value)` (max-only).
- **transition controller** — given `from` and `to` `FractalState` + a node diff,
  runs a temporary `requestAnimationFrame` ease (~1.5s) then `cancelAnimationFrame`.
  Starts only when `to !== from` or the diff is non-empty. Never runs idle.
- **`MandelbrotCanvas`** — unchanged zoom/pan; gains one prop `fractalState` and
  passes two new uniforms to the shader.
- **`FilamentText`** — replaces `NodeOverlay`. Renders memory text along filament
  tangents with iridescence + LOD; renders birth/extinction during transitions.

## Signal Mapping (`deriveFractalState`)

### Depth — hybrid floor + living volume (resolves the monotonic-vs-cataclysm tension)

```
floor      = monotonic baseline from lifetime maturity
             (RSI engine.iteration high-water and/or bounds_version), persisted.
             NEVER decreases.
reactive   = f(eliteNodeCount)   e.g. k * log2(1 + eliteNodeCount)
depthBoost = floor + reactive    (reactive clamped >= 0)
```

- Pruning drops `reactive` → filaments beyond the floor **retract** → "airy".
- `floor` guarantees a permanent earned baseline; the agent never visually
  regresses to zero once matured.
- `depthBoost` is added to the existing zoom-driven iteration count in
  `mandelbrot.ts` (`u_maxIter = f(zoom) + u_depthBoost`), bounded by the 2048
  shader loop cap.

### Morph — subtle, RSI-driven, graceful-null

```
morph = clamp(g(rsi.engine.iteration), 0, 0.12)   // small breathing range
morph = 0   when rsi == null OR rsi.engine == null  // MANDATORY graceful default
```

- `RsiStatus.engine` is `null` until the sidecar emits events (`index.ts:213`).
  Reading `engine.iteration` without the null guard crashes first run.
- In the shader, `c = mix(c_pixel, c_seed, u_morph)` — small Julia interpolation
  so the boundary undulates without detaching from the node anchor region.
- Capped at 0.12 deliberately: a full Julia morph makes the set unrecognizable
  and would float the (Seahorse-Valley-anchored) text over unrelated structure.

## Shader Changes (`lib/fractal/mandelbrot.ts`)

1. **Growth:** new uniform `u_depthBoost`; `u_maxIter = max(120, f(zoom) + depthBoost)`,
   still clamped to the 2048 loop cap. Empty DB ⇒ depthBoost 0 ⇒ low floor ⇒
   smooth inert disc (Tabula Rasa).
2. **Morph:** new uniform `u_morph`; inside the iteration loop,
   `c_eff = mix(c, C_SEED, u_morph)` with a fixed interesting `C_SEED`
   (e.g. a Julia constant near the boundary). `z = z² + c_eff`.
3. **Anti-aliasing (the *real* fix for the pixelated screenshot):** 2×2
   supersampling in the fragment shader — compute escape-time at 4 sub-pixel
   offsets and average. This removes the salt-and-pepper speckle at zoom-out.
   **Note:** the speckle is *under-sampling aliasing*, NOT CSS image-scaling.
   The shader already recomputes z→z²+c per physical pixel each draw
   (`mandelbrot.ts:167-178`), so zoom is already resolution-independent. We do
   **not** touch the zoom/pan logic.

## Node Representation (`FilamentText`, replaces `NodeOverlay`)

Memory text woven along the fractal filaments instead of glow orbs.

For each visible node at complex coord `c0`:
1. Sample `∇(smooth iteration)` around `c0` (4 samples) on the CPU side using
   the same escape-time math the shader uses (shared helper).
2. Filament tangent = perpendicular to the gradient (the local level-set
   direction).
3. Draw the node label as text rotated onto that tangent (`ctx.rotate`),
   character-by-character along the curve so the text "wraps" the branch.
4. **Iridescence:** per-character hue shift across the Feral palette
   (lavender/violet in light, amber/orange in dark) + subtle glow.
5. **Edges (relations):** routed along field-flow between related nodes as
   "data streams" rather than straight lines.

**LOD (kept from current overlay):** filament-aligned text only when zoomed in
enough; discrete sparks/dots when zoomed far out or when the visible set is
dense (1000+), to keep it legible and cheap. Reuse the existing draw caps
(`MAX_DRAWN`, glow budget) and viewport culling.

**Cost honesty:** gradient sampling per node is more expensive than orbs;
acceptable for the hundreds of nodes visible after LOD/culling, not for drawing
thousands of labels at once (LOD prevents that).

## Lifecycle: Birth & Extinction (user-driven transitions)

The transition controller holds the **previous** and **next** node snapshots and
diffs them on Refresh/mount:

- **Birth** (in next, not in prev): text fades in and "draws on" along its
  filament tangent.
- **Extinction** (in prev, not in next): text fades out character-by-character
  along the curve; if a whole region/mini-Mandelbrot's nodes all leave, that
  cluster dissolves together. The controller must **render departing nodes** from
  the previous snapshot for the fade-out duration (current overlay renders only
  the current snapshot — this is the real change).
- Structural retraction (filaments receding) comes "for free" from `depthBoost`
  easing down as `reactive` drops between the two snapshots.

All of this plays only when the user triggers Refresh/mount. Background prunes
and RSI iterations change state silently; the visual updates the next time the
user looks/refreshes. Consistent with "nothing animates on auto."

## Error Handling / Edge Cases

- `rsi.status()` throws or `engine == null` → `morph = 0`, depth uses memory-only
  signal + persisted floor. No crash.
- `getGraph()` empty → Tabula Rasa state (depthBoost 0, no text).
- WebGL2 unavailable → existing CSS flat-field fallback retained.
- localStorage unavailable → maturity floor falls back to 0 (in-memory only);
  feature degrades to reactive-only depth, no crash.
- Transition interrupted by a new Refresh → cancel the running rAF, restart from
  the current interpolated value to the new target.

## Testing

- `deriveFractalState` (pure): empty DB → depthBoost 0; monotonic floor never
  decreases; `engine null` → morph 0; morph clamped at 0.12; reactive shrinks
  when eliteNodeCount shrinks but total stays ≥ floor.
- maturity store: `bump` is max-only; survives reload (mock localStorage).
- lifecycle diff: birth/extinction sets computed correctly from prev/next.
- Shader is not unit-tested; verified visually via `bun run` (sidecar/build per
  project conventions — TS changes need rebuild + copy to `src-tauri/binaries/`
  only if they touch the sidecar; this work is frontend-only).

## Future (Phase B — deferred, not implemented now)

Nodes as **perturbation seeds** that physically warp the fractal boundary near
their coordinates. Technical sketch for when we revisit:
- Pass node positions as a **texture** (not a uniform array — 1000+ nodes exceed
  `MAX_FRAGMENT_UNIFORM_VECTORS`).
- Shader reads a perturbation field with a **cap** (nearest-K or a pre-baked
  SDF) to keep it O(pixels × K), not O(pixels × N).
- Gate on measured Phase A performance first.

## Scope Boundary (Phase A = this spec)

In: shader growth + morph + AA fix; `deriveFractalState`; maturity floor;
filament-text node rendering with iridescence + LOD; birth/extinction transitions;
tests. Out: perturbation seeds (Phase B); any auto/ambient animation.
