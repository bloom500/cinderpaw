# Checkpoint — the ox-alpha ARC stack, mapped

**2026-08-26.** Read-only audit of the seven systems on
`feat/benchmark-mode-isolation` (the ox-alpha stack merged with cowork).
Nothing was changed to produce this. Fixes come after, sequentially.

## One-line verdict

**Seven real, tested modules and no machine.** Every piece exists and every
piece has tests. Nothing composes them: the search never runs, the skills are
never induced, and the one script shaped like ARC-AGI-3 shares no code with
the solver. The stack is a parts bin, not a harness.

And the parts are cut for a different benchmark than the one we are entering
— see "The shape problem", which is the finding that matters most.

## Inventory

| # | System | File | Lines | Tests | Called by |
|---|---|---|---|---|---|
| 1 | Scene Graph Perception | `src/research/perception/scene-graph.ts` | 314 | 24 | `primitives.ts` (one function) |
| 2 | DSL primitives | `src/rlm/dsl/primitives.ts` | 293 | 29 | `mcts-verifier` (as compile scope) |
| 3 | MCTS | `src/core/mcts-verifier.ts` | 595 | 34 | **nothing** |
| 4 | Active Verifier | same file | — | (in the 34) | `mcts-verifier` internally |
| 5 | Skill Induction | `src/memory/fractal/skill-induction.ts` | 250 | 15 | **nothing** |
| 6 | TTT dataset builder | `scripts/lora-trainer/test_time_adaptation.ts` | 216 | 10 | its own CLI |
| 7 | Run Manifest | `src/core/run-manifest.ts` | 231 | 16 | `run_maze_selftest.mjs` |
| + | Causal explorer | `src/perception/causal-explorer.ts` | 159 | 7 | **nothing** |

135 tests across the eight. They pass.

## Corrections to the working summary

- **The DSL has 11 primitives, not 6.** Beyond rotate / mirror / shift /
  floodFill / applyGravity / recolor there are `crop`, `replaceColor`,
  `selectByColor`, `selectLargest`, `selectSmallest`.
- **MCTS candidate generation is data-driven, not a static pool.** It reads
  the task pairs and composes `recolor(from,to)` for colors that actually
  disappear and appear, plus a `floodFill` seeded from real pixels. Capped at
  32 candidates per node. This is better than the summary implies.
- **Determinism confirmed**: no `Math.random` anywhere in the module; default
  budget 200 iterations, validated as an integer ≥ 1.

## The shape problem

`runMCTSVerification` searches for a program that maps
`TaskPair { input: Grid, output: Grid }` — a grid-to-grid transform inferred
from worked examples. That is the shape of **ARC-AGI-1/2** (transduction).

**ARC-AGI-3 is interactive.** You receive a grid observation, choose an
action, and are scored (RHAE) on the actions taken across 183 levels. Nothing
hands you input/output pairs to generalise from. A program synthesiser that
turns example pairs into a transform does not, by itself, play a game.

The one artifact in the repo shaped like AGI-3 is
`scripts/arc/run_maze_selftest.mjs` — ACTION1..ACTION4, an environment, a
policy. It imports the run manifest and **nothing else from this stack**. The
two halves of the "recipe" have never met, and are not currently shaped to.

This does not make the stack useless: perception and the DSL are plausible
TOOLS for an action-choosing agent, and the verifier is a real scorer. But
"we have the pieces AVO had" is not supported by what is on disk. What is on
disk is a solver for a different task family plus a maze demo.

## What is missing, in dependency order

1. **An ARC-AGI-3 client.** Still nothing for `three.arcprize.org` in any
   branch. Confirmed again today.
2. **An orchestrator.** Nothing calls MCTS or skill induction. There is no
   loop that goes observe → decide → act → learn.
3. **A decision layer for actions.** The stack decides *transforms*, not
   *actions*. This is the design gap, not a coding gap.
4. **TTT wiring.** The dataset builder writes the trainer's format and the
   trainer is live in `dispatch.ts` (CliTrainer → QLoRA → eval gate → human
   gate). Nothing connects them. Blocked on trigger decisions, not on code.

## Honest notes

- Every module validates its inputs loudly and has real edge-case tests. This
  is not scaffolding — it is good code that nothing calls.
- `runMCTSVerification` gained `holdOutPairs` in `fix/arc-harden`; skill
  induction gained `runId` + the evidence gate. Both fixes are real and both
  are on code with no production caller, so neither has ever run outside a
  test.
- The run manifest has exactly one consumer. Val 3 was meant to be its
  second; that is still true.

## Related

`docs/agents-memory/project_arc_agi3_campaign.md` (v3 roster),
`OPUS_CHECKPOINT_20260824.md`.
