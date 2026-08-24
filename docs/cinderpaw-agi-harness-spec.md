# Cinderpaw AGI Harness Specification — ARC-AGI-3 Focus

**Document Status:** Architecture Direction & Implementation Blueprint  
**Version:** 1.1.0 (Refined after Opus Review — 2026-08-24)  
**Target Environment:** Cinderpaw Core (`FeralAgent`), RLM REPL (`rlm/repl.ts`), ARC-AGI-3 Interactive API  
**Primary Target:** ARC-AGI-3 Public Interactive Demo Set (25 Environments)  

---

## 1. Executive Summary & Directional Target

This document serves as the **directional architecture blueprint** for extending Cinderpaw's reasoning capabilities using an interactive, neuro-symbolic harness.

### Key Refinements (from Engineering Audit)
1. **Single Target:** Focus strictly on **ARC-AGI-3** (interactive turn-by-turn game API), decoupling from ARC-AGI-1/2 static grid pair formats.
2. **Empirical Baseline First:** Rather than assuming target percentages, Cinderpaw follows an **Empirical Measurement Protocol**: establish a raw baseline score on ARC-AGI-3 first, then measure the delta added by each individual module.
3. **Incremental Sequencing:** Build and measure **one module at a time** (Perception $\to$ DSL $\to$ MCTS/Verifier) to isolate the highest-yield improvements.

---

## 2. ARC-AGI-3 Interactive Architecture vs. Baseline

ARC-AGI-3 differs fundamentally from static grid puzzles:
* **Format:** Interactive turn-based game environments (state observation $\to$ action execution $\to$ environment feedback loop).
* **Objective:** Discover hidden rules and goal conditions dynamically through interaction.

```text
                  +-------------------------------------------------------+
                  |         ARC-AGI-3 INTERACTIVE ENVIRONMENT             |
                  +-------------------------------------------------------+
                                    |                ^
                      State (Grid)  |                | Action
                                    v                |
                  +-------------------------------------------------------+
                  |  MODULE 1: SCENE GRAPH PERCEPTION (`scene-graph.ts`)   |
                  |  Filters raw grid into spatial object representation  |
                  +-------------------------------------------------------+
                                    |
                                    v
                  +-------------------------------------------------------+
                  |  MODULE 2: RLM REPL & DSL PRIMITIVES (`repl.ts`)       |
                  |  Simulates actions & composes DSL helper logic        |
                  +-------------------------------------------------------+
                                    |
                                    v
                  +-------------------------------------------------------+
                  |  MODULE 3: ACTIVE VERIFIER & METACOGNITION            |
                  |  Detects stagnation, resets false hypotheses          |
                  +-------------------------------------------------------+
```

---

## 3. Incremental Implementation Roadmap

### Phase 1: Baseline Measurement Runner (`scripts/arc/run_arc_agi3_baseline.mjs`)
- [ ] Create a minimal ARC-AGI-3 runner that connects raw Cinderpaw to 1 interactive environment.
- [ ] Record **Baseline 0**: Measure action count, score, token spend, and failure modes on raw model execution.

### Phase 2: Perception Layer Integration (`FeralAgent/src/perception/scene-graph.ts`)
- [x] Implemented `parseSceneGraph` (CCA, bounding boxes, spatial relations) and `formatSceneGraphToYaml`.
- [x] Implemented unit tests in `FeralAgent/tests/scene-graph.test.ts` (100% passing).
- [ ] Measure **Delta 1**: Measure score improvement when providing Scene Graph context vs. raw grids.

### Phase 3: DSL Standard Primitives (`FeralAgent/src/rlm/dsl/primitives.ts`)
- [x] Implemented atomic primitives (`rotate`, `mirror`, `recolor`, `floodFill`, `crop`, `applyGravity`).
- [x] Bound `DSL` into RLM REPL namespace in `FeralAgent/src/rlm/repl.ts`.
- [ ] Measure **Delta 2**: Measure reduction in LLM token spend and action steps.

### Phase 4: Active Verifier & Metacognitive Stagnation Detection
- [ ] Implement `FeralAgent/src/core/mcts-verifier.ts` for multi-hypothesis search and stagnation recovery.
- [ ] Measure **Delta 3**: Final evaluation on all 25 public demo environments.

---

## 4. Verification & Testing Standards

All modules added under this harness must satisfy:
1. **Isolated Unit Testing:** Vitest suite in `FeralAgent/tests/` passing 100%.
2. **Zero Invariant Violations:** Respect BRSI safety invariants `I1` (Ratchet) and `I2` (Rollback) in `rsi/`.
3. **Empirical Log Verification:** Public logs generated under `scripts/arc/logs/` detailing total tokens, latency, and step counts per run.

---
*Updated and committed to Cinderpaw repository as `docs/cinderpaw-agi-harness-spec.md`.*
