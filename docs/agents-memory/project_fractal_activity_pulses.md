# FractalActivity pulses — the three event kinds

The Mandelbrot organism in `frontend-react/src/pages/MemoryLayersPage.tsx`
is driven by `fractal_activity` lines emitted on the sidecar stdout and
forwarded verbatim by Rust over `feral://agent-output`. The
`FractalActivity` union in `FeralAgent/src/memory/fractal/fractal-memory.ts`
has THREE members (don't add a fourth without checking the FE filter):

| kind     | when it fires                                   | FE effect              |
| -------- | ----------------------------------------------- | ---------------------- |
| `grow`   | tree was rebuilt (gated by `rebuildIfStale(1.2)`) | full filament regrowth |
| `recall` | every user turn that hit the semantic path       | breathing pulse        |
| `seed`   | every single memory write (per-iteration, cheap) | breathing pulse        |

## Why `seed` exists (regression guard)

Without it, +1 memory on top of 2700 leaves is invisible to the organism
until the next 1.2× rebuild — which on 2700 means ~540 more memories
must accumulate before anything visible happens. The user's vision was
"a fine impulse at every iteration", not "a giant warp every 540
writes", so `seed` carries the per-write signal.

- `seed` does NOT trigger a rebuild (cheap; no LLM cost).
- `seed` fires regardless of tree state (no tree → still fires).
- `seed` is wired from `agent-loop.ts` AFTER each `episodic.record(...)`
  call site (user / assistant / tool). See `this.#recall?.noteWrite?.(...)`.
- `EpisodicMemory.record()` now returns `number | null` (the inserted row
  id) so the agent loop has the leafId to pass into `noteWrite`.

## Wiring at every hop

1. `agent-loop.ts:563/587/857` — after `episodic.record()`, call
   `this.#recall?.noteWrite?.({id, sessionId, ts})`.
2. `FractalMemory.noteWrite` emits `{kind: "seed", ...}` via the same
   `#onActivity` sink that `recall()` and `#doRebuild()` use.
3. `index.ts:700-701` forwards to the transport (no `as unknown` cast —
   `fractal_activity` is a typed member of `OutboundEvent`).
4. Rust `feral_agent.rs:stdout_reader` forwards the line verbatim.
5. `events.ts:onFractalActivity` listener filters `type === "fractal_activity"`.
6. `MemoryLayersPage.tsx:139-145` handles all three kinds — `seed` and
   `recall` both call `startBreathing()` (same self-terminating morph
   swell).

## Tests that pin this contract

`FeralAgent/tests/fractal-memory-activity.test.ts`:
- "emits a seed pulse on every noteWrite so a single +1 leaf is visible"
  (regression guard: must fire WITHOUT a tree)
- "emits a seed pulse even when a tree is loaded (independent of grow)"
- "noteWrite does NOT trigger a rebuild or a grow pulse" (cheap guarantee)
- "noteWrite never throws when the activity sink throws"

## Diagnostic one-liner

```bash
bun test tests/fractal-memory-activity.test.ts
# expect: 10 pass, 0 fail (5 original + 4 seed + 1 buildGrowActivity)
```
