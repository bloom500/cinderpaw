# RSI Evolution Spec — Cinderpaw → True Recursive Self-Improvement

> **Status:** Draft for Opus implementation (2 days)
> **Author:** bloom500 + opencode
> **Date:** 2026-06-29
> **Supersedes:** None (this is the first version)

---

## 1. What We Have Today (Faza 1 — Config Evolution)

### 1.1 Current Architecture

Cinderpaw's "RSI" is a **config evolution engine** — an evolutionary algorithm that tunes agent configuration parameters against a frozen eval suite and ratchets improvements to git.

**Genome (the unit of evolution):**
```typescript
interface GenomeConfig {
  promptTemplateId: number;        // index into prompt pool
  temperature: number;             // LLM sampling temperature
  systemPromptId: number;          // index into system-prompt pool
  retrievalStrategy: "episodic" | "semantic" | "graph" | "hybrid";
  contextWindowUsage: number;      // fraction [0.1, 0.95]
  toolPreferenceWeights: number[]; // simplex (sums to 1)
  decompositionDepth: number;      // {0, 1, 2, 3}
}
```

**What it does:**
- Mutates config params (Gaussian perturbation, random walk, transfer mutation)
- Crossovers between divergent genomes (NEAT-speciation)
- Evaluates against Tier 0/1/2 eval suite (24 tasks: fact lookups, JSON format, token budget, latency)
- Scores via Rust-side pure function: `score = 55*success - 15*cost - 20*error - 10*latency`
- Git-ratchets improvements (monotonic, candidate > main → fast-forward)
- Applies champion to live agent

**What it does NOT do:**
- Does not modify the agent's TypeScript code
- Does not modify the agent's architecture
- Does not modify the underlying model weights
- Does not generate a successor system
- Does not self-modify the mutation/selection/scoring mechanism

### 1.2 Gap vs. True RSI

| Dimension | Wikipedia RSI | Anthropic RSI | Sakana DGM | Cinderpaw Faza 1 |
|-----------|---------------|----------------|------------|----------------|
| **What it rewrites** | Own source code | Architecture + training + code | Own codebase | Config parameters (7 fields) |
| **Level of change** | Code → arch → hardware | Code + training pipeline | Agent code + foundation model | JSON config |
| **Autonomy** | Full | Semi (human review) | Full (open-ended) | Bounded episode, event-driven |
| **Recursive?** | Yes — each iteration makes next more capable | Yes — 80% code by AI | Yes — continuous lineage | Partial — improvements don't apply to RSI itself |
| **Self-modifies?** | Yes | Yes | Yes | No |

**The core gap:** Cinderpaw optimizes the policy (config) but not the implementation (code). True RSI means the system improves the mechanism that does the improving.

---

## 2. The Roadmap: 5 Fazes to True RSI

### Naming Convention

Each Faza is a **superset** of the previous one. The existing Faza 1 engine keeps running. New capabilities are added as new genome types, new eval kinds, and new mutation operators — all wired through the same engine composition root.

---

### Faza 2: Code Evolution (Self-Modifying Agent)

**Goal:** The agent can propose, test, and commit patches to its own TypeScript codebase.

**What changes:**
- New genome type: `CodeGenome` (represents a patch/diff, not config params)
- New eval kind: `"code_quality"` — edit code → run tests → measure pass rate
- New mutation operator: LLM-driven code proposal (the agent suggests patches)
- New bridge method: `rsi_commit_code_patch` (version-control code changes)
- New eval task: "run CinderpawAgent's own test suite and measure pass rate"

**Genome type:**
```typescript
interface CodeGenome {
  /** The patch to apply (unified diff format) */
  patch: string;
  /** Files affected by the patch */
  affectedFiles: string[];
  /** Base commit hash (what this patch is applied on top of) */
  baseCommit: string;
  /** Metadata about the proposal */
  proposal: {
    rationale: string;       // why this change helps
    riskAssessment: string;  // self-assessed risk level
    testPlan: string;        // what tests to run
  };
}
```

**Eval pipeline for code-RSI:**
```
1. Agent reads its own codebase
2. Agent proposes a patch (LLM-generated)
3. Patch is applied to a sandboxed copy
4. Tests are run (bun test)
5. Lint is run (bunx tsc --noEmit)
6. Build is attempted (bun run build)
7. Score = f(test_pass_rate, lint_clean, build_success, diff_size)
8. If score > current_best → git ratchet → apply to live
```

**Guardrails:**
- **Max lines changed per iteration:** 200 lines (prevents wholesale rewrite)
- **File-type restriction:** Only `.ts` files in `CinderpawAgent/src/rsi/` (the evolution engine itself — not the whole app)
- **Tier 0 invariant:** "All 1255 existing tests must still pass" — this is the fitness floor
- **Rollback:** If live agent crashes after applying a code patch, auto-revert to last known-good commit
- **Human approval gate:** First 10 code patches require UI confirmation before apply
- **No network access during code-RSI:** The patch proposal step uses only local inference

**What already exists:**
- ✅ File write/edit tools (`edit_file`, `write_file`)
- ✅ Test runner (`run_tests`)
- ✅ Linter (`lint_code`)
- ✅ Build tool (`build_project`)
- ✅ Git operations (`git_commit`, `git_diff`, `git_log`)
- ✅ Bridge architecture (extensible dispatch)
- ✅ Sandbox bounds (immutable core)

**What needs to be built:**
- ❌ `CodeGenome` type + serializer
- ❌ `rsi_commit_code_patch` bridge method (Rust side)
- ❌ Code-RSI mutation operator (LLM-driven patch proposal)
- ❌ Code-RSI eval runner (edit → test → score)
- ❌ Code-RSI scorer addition (test pass rate, lint, build)
- ❌ Rollback mechanism (auto-revert on crash)
- ❌ Human approval gate (first N patches)

---

### Faza 3: Meta-Evolution (Self-Modifying Evolution)

**Goal:** The agent can modify its own evolution mechanism — mutation operators, selection pressure, eval suite composition, scoring weights.

**What changes:**
- New genome type: `MetaGenome` (modifies the evolution engine's parameters)
- New eval kind: `"meta_fitness"` — does the modified evolution engine produce better genomes?
- New mutation operator: LLM-driven meta-proposal (suggest changes to mutation/selection/scoring)

**Genome type:**
```typescript
interface MetaGenome {
  /** Modifications to the mutation grammar */
  mutationGrammar?: Partial<MutationGrammar>;
  /** Modifications to selection pressure */
  selectionPressure?: number;
  /** Modifications to scoring weights (Rust side — needs bridge call) */
  scoringWeights?: { w1: number; w2: number; w3: number; w4: number };
  /** Modifications to eval suite composition */
  evalComposition?: {
    tier1Weight: number;
    tier2Weight: number;
    additionalSpecs?: EvalSpec[];
  };
  /** Modifications to extinction thresholds */
  extinctionThresholds?: {
    monocultureThreshold: number;
    plateauPatience: number;
    killFraction: number;
  };
}
```

**Eval pipeline for meta-RSI:**
```
1. Agent reads its own evolution engine code
2. Agent proposes a meta-patch (e.g., "increase selection pressure from 1.0 to 1.3")
3. Meta-patch is applied to the engine
4. A mini-evolution run is executed (5 generations, small population)
5. Score = f(improvement_rate, diversity_maintained, convergence_speed)
6. If score > current_best → git ratchet → apply to live engine
```

**Guardrails:**
- **Tier 0 scoring weights are immutable** — the agent cannot modify `w1/w2/w3/w4` in Rust (protected by `SandboxBounds`)
- **Selection pressure bounds:** [0.5, 2.0] — prevents extreme exploitation or random search
- **Mutation grammar bounds:** sigma values clamped to [0.01, 0.5] — prevents exploding/vanishing mutations
- **Mini-evolution validation:** Must run at least 5 generations before judging meta-change
- **Diversity floor:** If niche count drops below 3, meta-change is rejected
- **Human approval gate:** All meta-patches require UI confirmation

**What already exists:**
- ✅ Mutation grammar (`mutation.ts`)
- ✅ Selection handler with live pressure (`selection-handler.ts`)
- ✅ Extinction handler with thresholds (`extinction-handler.ts`)
- ✅ Scoring weights in Rust (`scorer.rs`)
- ✅ Eval spec system with disk overrides (`tier-loader.ts`)
- ✅ Population manager with fitness sharing

**What needs to be built:**
- ❌ `MetaGenome` type + serializer
- ❌ `rsi_apply_meta_patch` bridge method
- ❌ Meta-RSI mutation operator (LLM-driven meta-proposal)
- ❌ Meta-RSI eval runner (mini-evolution benchmark)
- ❌ Meta-RSI scorer (improvement rate + diversity)
- ❌ Bounds clamping for all meta-parameters
- ❌ Human approval gate

---

### Faza 4: Architecture Evolution (Self-Modifying Architecture)

**Goal:** The agent can introduce new subsystems — new memory types, new planners, new schedulers, new tool categories.

**What changes:**
- New genome type: `ArchGenome` (represents a new subsystem or modified architecture)
- New eval kind: `"arch_fitness"` — does the new subsystem improve end-to-end performance?
- New bridge method: `rsi_register_subsystem` (register a new tool/memory/scheduler)
- New safety boundary: subsystems run in isolated sandboxes

**Genome type:**
```typescript
interface ArchGenome {
  /** The new subsystem to introduce */
  subsystem: {
    type: "memory" | "planner" | "scheduler" | "tool" | "reasoning_pipeline";
    name: string;
    code: string;           // TypeScript source of the new subsystem
    config: Record<string, unknown>;
  };
  /** Integration points — where this subsystem plugs in */
  integration: {
    hooksInto: string;      // e.g., "recall.ts", "dream-scheduler.ts"
    priority: number;       // execution order
  };
  /** Dependencies */
  dependencies: string[];   // npm packages or internal modules needed
}
```

**Eval pipeline for arch-RSI:**
```
1. Agent identifies a capability gap (e.g., "no graph-based memory")
2. Agent proposes a new subsystem (code + integration plan)
3. Subsystem is compiled and loaded in sandboxed mode
4. End-to-end benchmark runs (full eval suite + new subsystem tasks)
5. Score = f(benchmark_improvement, resource_overhead, stability)
6. If score > current_best → git ratchet → register subsystem in live agent
```

**Guardrails:**
- **Subsystem sandbox:** New subsystems run in isolated Worker threads with no access to:
  - The scorer (immutable)
  - SandboxBounds (immutable)
  - Tier 0 eval specs (immutable)
  - The git substrate (read-only)
- **Resource caps:** New subsystems cannot consume > 512MB RAM or > 50% CPU
- **Dependency allowlist:** Only packages from `package.json` + `Cargo.lock` — no new npm installs
- **Integration test:** New subsystem must pass a dedicated integration test before live apply
- **Rollback:** If agent crashes after subsystem registration, auto-unload and revert
- **Human approval gate:** All architecture changes require UI confirmation
- **Max 1 subsystem per dream cycle** — prevents cascading changes

**What already exists:**
- ✅ Tool registry with permission system (`registry.ts`)
- ✅ Delegate task (subagent spawning) (`delegate-task.ts`)
- ✅ Fractal memory system (reference architecture for new memory types)
- ✅ Dream scheduler (reference architecture for new schedulers)
- ✅ Event bus (reference architecture for new pipelines)

**What needs to be built:**
- ❌ `ArchGenome` type + serializer
- ❌ `rsi_register_subsystem` bridge method
- ❌ Subsystem sandbox (isolated Worker thread)
- ❌ Subsystem loader/unloader (hot-pluggable modules)
- ❌ Arch-RSI eval runner (end-to-end benchmark)
- ❌ Arch-RSI scorer (improvement + overhead + stability)
- ❌ Resource monitor (RAM/CPU caps per subsystem)

---

### Faza 5: Foundation Model Evolution (True RSI)

**Goal:** The agent can modify the foundation model itself — fine-tuning, LoRA, ensemble selection, or proposing architectural changes to the model.

**What changes:**
- New genome type: `ModelGenome` (represents a model modification)
- New eval kind: `"model_fitness"` — does the model change improve end-to-end performance?
- New bridge method: `rsi_apply_model_change`
- New safety boundary: model changes require full eval suite validation + human confirmation

**Genome type:**
```typescript
interface ModelGenome {
  /** The model modification to apply */
  modification: {
    type: "lora_adapter" | "ensemble_weight" | "prompt_engineering" | "architecture_proposal";
    /** For LoRA: the adapter weights */
    adapterPath?: string;
    /** For ensemble: weights across multiple models */
    ensembleWeights?: Record<string, number>;
    /** For prompt engineering: the new prompt template */
    promptTemplate?: string;
    /** For architecture proposal: a description + pseudocode */
    architectureProposal?: string;
  };
  /** Which model(s) this modification targets */
  targetModels: string[];
  /** Expected improvement (self-assessed) */
  expectedImprovement: string;
}
```

**Guardrails:**
- **Model changes are read-only by default** — the agent can propose but not apply without human confirmation
- **Ensemble weights bounded:** [0.0, 1.0], sum to 1.0
- **LoRA adapter size cap:** 100M parameters max (prevents resource exhaustion)
- **Full eval suite required:** Must pass all Tier 0 + Tier 1 + Tier 2 before apply
- **Human approval gate:** ALL model changes require explicit UI confirmation (no auto-apply)
- **Rollback:** Model changes are versioned; instant rollback to previous model on regression
- **Cost cap:** Model changes cannot increase inference cost by > 2x

**What already exists:**
- ✅ Inference router with model selection (`InferenceRouter`)
- ✅ Provider abstraction (OpenAI, Anthropic, local GGUF)
- ✅ LoRA infrastructure (if using llama.cpp with LoRA support)
- ✅ Cost tracking (`rsi-cost.ts`)

**What needs to be built:**
- ❌ `ModelGenome` type + serializer
- ❌ `rsi_apply_model_change` bridge method
- ❌ LoRA adapter loader/unloader
- ❌ Ensemble inference router
- ❌ Model-RSI eval runner (full benchmark)
- ❌ Model-RSI scorer (performance + cost + stability)
- ❌ Model rollback mechanism

---

## 3. Implementation Priority for Opus (2 Days)

### Day 1: Faza 2 (Code Evolution)

**Morning (4h):**
1. Define `CodeGenome` type in `CinderpawAgent/src/rsi/code-genome.ts`
2. Implement `rsi_commit_code_patch` bridge method in `src-tauri/src/rsi/commands.rs`
3. Implement `makeCommitCodePatchAdapter` in `CinderpawAgent/src/rsi/adapters.ts`
4. Implement code-RSI eval runner: `makeRunCodeEval` in `CinderpawAgent/src/rsi/run-code-eval.ts`
5. Wire code-RSI eval kind into `eval-spec.ts`

**Afternoon (4h):**
6. Implement code-RSI mutation operator: `makeCodeMutationOperator` in `CinderpawAgent/src/rsi/code-mutation.ts`
7. Implement rollback mechanism: `autoRevertOnCrash` in `CinderpawAgent/src/rsi/code-rollback.ts`
8. Add code-RSI scorer addition to `src-tauri/src/rsi/scorer.rs`
9. Wire code-RSI into engine composition root (`engine.ts`)
10. Write tests for all new components

### Day 2: Faza 3 (Meta-Evolution) + Integration

**Morning (4h):**
1. Define `MetaGenome` type in `CinderpawAgent/src/rsi/meta-genome.ts`
2. Implement `rsi_apply_meta_patch` bridge method
3. Implement meta-RSI mutation operator
4. Implement meta-RSI eval runner (mini-evolution benchmark)
5. Add bounds clamping for all meta-parameters

**Afternoon (4h):**
6. Wire Faza 2 + Faza 3 into the dream cycle
7. Add human approval gates (UI confirmation flow)
8. Update telemetry to track code/meta changes
9. Write integration tests
10. Update CHANGELOG + README

---

## 4. Safety Architecture (All Fazes)

### 4.1 Immutable Core (Never Modified by RSI)

These are protected by `SandboxBounds` in Rust and cannot be changed by the agent:

| Component | Protection Mechanism |
|-----------|---------------------|
| Scorer formula + weights | `SandboxBounds.scoring_weights` — UI-only mutation |
| Tier 0 eval specs | Frozen in `tier0.rs` — no filesystem access |
| SandboxBounds file | Hash-chained audit log, requires UI confirmation |
| Audit log | Append-only, hash-chained |
| Git substrate | Agent can commit to candidate branches; only Rust can ratchet main |
| Agent runtime | The sidecar binary itself — agent can propose patches but not apply without approval |

### 4.2 Human Approval Gates

| Faza | Approval Required? | Auto-apply? |
|------|-------------------|-------------|
| Faza 1 (Config) | No | Yes (config is safe) |
| Faza 2 (Code) | First 10 patches | After 10 successful patches, auto-apply with rollback |
| Faza 3 (Meta) | Always | No — all meta-changes require confirmation |
| Faza 4 (Arch) | Always | No — all architecture changes require confirmation |
| Faza 5 (Model) | Always | No — all model changes require confirmation |

### 4.3 Rollback Mechanism

```
Agent proposes change → Change is applied → Agent runs eval
  ↓
  ├─ Score improves + no crash → Keep change
  └─ Score regresses OR agent crashes → Auto-revert to last known-good
```

**Implementation:**
- Before applying any code/meta/arch change, snapshot the current state
- After applying, run a health check (all tests pass? agent responds to ping?)
- If health check fails → auto-revert + log the failure
- If health check passes but score regresses → flag for human review

### 4.4 Resource Caps

| Resource | Faza 2 | Faza 3 | Faza 4 | Faza 5 |
|----------|--------|--------|--------|--------|
| Max lines changed/iteration | 200 | N/A (meta) | N/A (arch) | N/A (model) |
| Max RAM for new subsystem | N/A | N/A | 512MB | N/A |
| Max CPU for new subsystem | N/A | N/A | 50% | N/A |
| Max LoRA params | N/A | N/A | N/A | 100M |
| Max cost increase | N/A | N/A | N/A | 2x |
| Max files modified/iteration | 5 | 3 | 1 | 1 |
| Eval suite before apply | All Tier 0+1+2 | 5-gen mini-evo | Full benchmark | Full benchmark |

### 4.5 Anti-Gaming Measures

| Risk | Mitigation |
|------|------------|
| Agent removes tests to improve score | Tier 0 tests are frozen in Rust — agent cannot modify |
| Agent modifies scorer | Scorer is Rust-side, protected by SandboxBounds |
| Agent removes detection markers (à la DGM) | Audit log is hash-chained — tampering is detectable |
| Agent overfits to eval suite | Goodhart detector watches for Tier 1 improvement + Tier 2 regression |
| Agent introduces hidden backdoors | All code changes are git-versioned with full diff history |
| Agent consumes excessive resources | Hard caps on lines changed, RAM, CPU, cost |

---

## 5. The RSI Naming Decision

### Current: "RSI (Recursive Self-Improvement)"

This name is **accurate for Faza 5** but **overpromises for Faza 1-2**.

### Recommendation

- **Faza 1-2:** Call it **"Config Evolution"** or **"Agent Genome Evolution (AGE)"** — this is what it actually does
- **Faza 3-5:** Call it **"RSI"** — at this point the system is genuinely self-improving the mechanism that does the improving
- **In marketing:** Use the full name with a footnote: *"Cinderpaw uses Agent Genome Evolution (AGE) today, with a roadmap to full Recursive Self-Improvement (RSI) across 5 development phases."*

### Why this matters

Every AI researcher who sees "RSI" will immediately think of Yudkowsky, Bostrom, Anthropic, Sakana. If the system only tunes config params, we lose credibility. If the system actually rewrites its own code (Faza 2+), the name is earned.

---

## 6. References

### Academic/Industry RSI

| Source | Key Insight | Applicable to Cinderpaw |
|--------|-------------|---------------------|
| Wikipedia RSI | "Seed improver" that rewrites own code | Faza 5 target |
| Anthropic "When AI Builds Itself" (2026) | AI writes 80% of code; semi-autonomous R&D loop | Faza 2-3 architecture |
| Sakana DGM (2025) | Open-ended evolution of self-improving coding agents; +30pp on SWE-bench | Faza 2-3 mutation/eval |
| Sakana LLM-Squared (2024) | LLMs invent better ways to train LLMs (DiscoPOP) | Faza 5 model evolution |
| Sakana RSI Lab (2026) | 4-phase trajectory: Agent-Native → AI Scientist → RSI → Democratized | Our roadmap maps to this |
| Yudkowsky/Bostrom Seed AI | Theoretical self-improving AI that recursively enhances own architecture | Faza 5 vision |

### Safety References

| Source | Key Insight | Applicable to Cinderpaw |
|--------|-------------|---------------------|
| DGM Safety | Transparent lineage, sandboxed eval, but agent hacked hallucination detection | Our audit log + SandboxBounds |
| Anthropic Constitutional AI | Immutable principles constrain self-modification | Our immutable core (scorer, Tier 0, bounds) |
| Sakana "Responsible RSI" | Open publication including negative results | Our telemetry + dream.jsonl |

---

## 7. Success Metrics

### Faza 2 (Code Evolution)
- Agent proposes a patch that passes all 1255 tests
- Agent proposes a patch that improves eval score by > 1 point
- Rollback works: agent crashes → auto-reverts within 5 seconds
- Human approval gate works: first 10 patches require confirmation

### Faza 3 (Meta-Evolution)
- Agent proposes a mutation grammar change that improves convergence speed
- Agent proposes a selection pressure change that maintains diversity
- Mini-evolution benchmark validates meta-change before apply
- Bounds clamping prevents extreme parameter values

### Faza 4 (Architecture Evolution)
- Agent introduces a new memory type (e.g., graph memory)
- New subsystem passes integration test
- Resource caps prevent OOM/CPU exhaustion
- Rollback works: subsystem unloaded on crash

### Faza 5 (Model Evolution)
- Agent proposes a LoRA adapter that improves benchmark score
- Ensemble weight change improves end-to-end performance
- Full eval suite validates model change before apply
- Human approval gate works: all model changes require confirmation

---

## 8. Open Questions

1. **Should Faza 2 code patches be limited to `rsi/` directory or expanded to the whole `CinderpawAgent/src/`?** Recommendation: Start with `rsi/` only, expand after validation.

2. **How do we handle the sidecar rebuild?** After code changes, the TypeScript needs to be recompiled. Options:
   - Hot-reload via dynamic imports (if Bun supports it)
   - Full rebuild + sidecar restart (current crash-restart mechanism)
   - Staged apply: code changes accumulate, then one rebuild per dream cycle

3. **Should meta-evolution (Faza 3) be allowed to modify the eval suite?** This is a classic Goodhart risk. Recommendation: No — the eval suite should be human-controlled. The agent can propose new eval tasks but they must be human-approved.

4. **How do we prevent "objective hacking" (à la DGM)?** The DGM hallucinated tool use and removed detection markers. Our mitigations:
   - Hash-chained audit log (tamper-evident)
   - Immutable scorer (agent cannot modify)
   - Tier 0 frozen specs (agent cannot remove tests)
   - Human approval gates for Faza 3+

5. **Should we allow the agent to propose new eval tasks?** This could be useful for expanding the eval suite, but also gaming-prone. Recommendation: Allow proposal, but new tasks go into a "pending" state until human approval.

---

*End of spec. Ready for Opus implementation.*
