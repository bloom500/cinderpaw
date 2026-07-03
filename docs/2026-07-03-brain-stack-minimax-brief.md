# Brain Stack — implementation brief (for MiniMax)

**Faza 4.6 — the differentiator: a runtime that picks the right model per task.**
Not a wizard, not packaging, not UI. The engine that turns Feral from "a wrapper
over one model" into "an orchestrator over many." Designed by Opus (seams +
contracts); you (MiniMax) implement the leaves against those fixed contracts.

> User's framing (Darius): *"The user doesn't talk to GPT or Claude. They talk to
> Feral. The model is just the engine chosen in the background."* Preserve that.

---

## 0. Read this first — ground truth, do NOT trust this brief blindly

This brief names real files, but **grep them before you code** — earlier specs
named artifacts that didn't exist. Confirm these by reading them:

- `FeralAgent/src/sandbox/inference-router.ts` — `class InferenceRouter`:
  `#primary`/`#fallback: ModelTarget`, `#providers: Record<string, InferenceProvider>`,
  `constructor(config: InferenceConfig, audit, db)`, `updateTargets(primary, fallback, trustedUrls)`,
  `get currentModel`, `async complete(req): Promise<InferenceResponse>` (dispatches
  to `#primary`, catches, retries `#fallback`), private `#callTarget` →
  `provider.complete(target, req, isFallback)` (~line 539).
- `FeralAgent/src/sandbox/inference-providers.ts` — **grep the exact definitions of
  `ModelTarget`, `InferenceConfig`, `InferenceRequest`, `InferenceResponse`,
  `InferenceProvider`** (this brief does NOT restate them — use the real ones).
- `FeralAgent/src/sandbox/circuit-breaker.ts` — `class CircuitBreaker`, states
  `closed|open|half_open`, keyed by string (currently "tool"). You will reuse it
  keyed by provider/model.
- `FeralAgent/src/core/agent-loop.ts` — the `this.#router.complete({ messages: memory.render(), ... })`
  call sites (~lines 1053, 1084, 1122). `#handle(..., images?: string[])`;
  `memory.addUser(userText, images)`. This is where classification input comes from.

**Rules:** after every file you write, `ls`/read it back to confirm it's on disk
(your output sometimes doesn't sync). Green tests ≠ correct — assert on real
behavior, not stubs. If a type here doesn't match the real one, the real one wins;
note the divergence in your report.

---

## 1. Architecture — Brain Stack sits ABOVE the router

```
              user turn (text + optional images)
                          │
                    ┌─────▼─────┐
                    │ Classifier│  task → Category  (heuristic MVP)
                    └─────┬─────┘
                          │  Category + Mode(budget|balanced|quality) + health
                    ┌─────▼───────────┐
                    │ CapabilityRouter│  score registry, pick {primary, fallback}
                    └─────┬───────────┘
                          │  {primary: ModelTarget, fallback?: ModelTarget}
                    ┌─────▼───────────┐
                    │ InferenceRouter │  completeWith(primary, fallback, req)
                    │ (existing)      │  ← existing failover/circuit/audit/abort
                    └─────────────────┘
```

**Separation of concerns (do not blur):**
- **BrainStack decides *which* model.** (new)
- **InferenceRouter decides *how to call it safely*** — failover, circuit,
  budget, audit, abort. (existing — reuse, don't reimplement)

**Opt-in.** When the Brain Stack is disabled (default until configured), agent-loop
calls `router.complete(req)` exactly as today. Nothing regresses. When enabled,
agent-loop calls `brain.route(req)` → targets → `router.completeWith(...)`.

---

## 2. The four pillars (from Darius)

1. **Capability Registry, not model names.** Route on capability vectors
   (`reasoning`, `coding`, `vision`, `speed`, `multilingual`) + `cost` + `local`.
   A new provider tomorrow = one registry entry, zero router changes.
2. **Cost-aware.** `Mode`: `budget` (prefer local/cheap, avoid expensive),
   `quality` (best capability, ignore cost), `balanced` (default).
3. **Health-aware.** Reuse `CircuitBreaker` keyed by target id. Open circuit →
   skip that model, route to next-best. Invisible failover.
4. **Personality ≠ Model.** SOUL/IDENTITY is loaded per session independent of the
   chosen model (it already is — confirm in agent-loop/soul-loader). Switching
   models MUST NOT change the persona or system prompt. Add a test that asserts it.

---

## 3. Contracts (fixed — implement to these)

New files under `FeralAgent/src/brain/`:

### 3a. `capability-registry.ts`
```ts
export type Capability = "reasoning" | "coding" | "vision" | "speed" | "multilingual";
export type Category =
  | "simple" | "coding" | "vision" | "reasoning" | "creative" | "multilingual" | "offline";

/** A model the Brain Stack can route to. `target` reuses the REAL ModelTarget. */
export interface BrainModel {
  id: string;                       // stable key, e.g. "claude-opus-5", "qwen-local"
  target: ModelTarget;              // provider/model/baseUrl/apiKey — the real type
  capabilities: Record<Capability, number>; // 0..10
  cost: 1 | 2 | 3;                  // 1 = cheap/local, 3 = premium
  local: boolean;
}

export class CapabilityRegistry {
  constructor(models: BrainModel[]);
  all(): BrainModel[];
  get(id: string): BrainModel | undefined;
  /** Models that are usable right now: have creds (or are local) AND circuit closed. */
  available(isHealthy: (id: string) => boolean): BrainModel[];
}
```

### 3b. `task-classifier.ts`
```ts
export interface Classification { category: Category; confidence: number; }

/** MVP heuristic — NO extra LLM call. Order matters (first match wins):
 *  1. images present            → "vision"
 *  2. offline (no cloud usable) → "offline"    (caller passes this hint)
 *  3. code fences / coding verbs (refactor|debug|compile|stack trace|regex|function) → "coding"
 *  4. reasoning cues (prove|derive|step by step|analyze|why) OR long prompt → "reasoning"
 *  5. creative (write a story|poem|lyrics|imagine) → "creative"
 *  6. otherwise short/factual   → "simple"
 */
export function classify(input: {
  text: string;
  hasImages: boolean;
  offline: boolean;
}): Classification;
```
Keep the heuristics in a table so they're testable and tunable. A future
local-LLM classifier is a **non-goal** for this slice.

### 3c. `brain-stack.ts`
```ts
export type Mode = "budget" | "balanced" | "quality";

/** category → required capability weights (what the task NEEDS). */
export const REQUIREMENTS: Record<Category, Partial<Record<Capability, number>>>;
// e.g. coding: { coding: 1.0, reasoning: 0.5 }, vision: { vision: 1.0 },
//      simple: { speed: 1.0 }, reasoning: { reasoning: 1.0 }, ...

export interface BrainConfig {
  enabled: boolean;
  mode: Mode;
  registry: BrainModel[];
  offlineModelId?: string;          // forced pick when category === "offline"
  overrides?: Partial<Record<Category, string>>; // pin a category to a model id
}

export class BrainStack {
  constructor(cfg: BrainConfig, breaker: CircuitBreaker);
  /** Pick primary + fallback for this turn. Pure given health state. */
  route(input: { text: string; hasImages: boolean; offline: boolean }):
    { classification: Classification; primary: ModelTarget; fallback?: ModelTarget; chosenId: string };
}
```

**Scoring** (specify exactly, keep it a pure function you can unit-test):
```
score(model, requirement, mode) =
    Σ_cap requirement[cap] * model.capabilities[cap]
  - modeWeight(mode) * model.cost            // budget: big penalty; quality: 0
  + (mode==="budget" && model.local ? localBonus : 0)
```
Filter to `registry.available(isHealthy)` first; if a category has an override,
use it (when available); if `offline`, force `offlineModelId`. `primary` = top
score, `fallback` = 2nd (different provider if possible). If nothing available →
throw a clear error the caller surfaces (don't silently pick a broken model).

### 3d. Seam into the existing router — `inference-router.ts`
Add ONE method (mirror `complete()` but with explicit targets; keep `complete()`
untouched as the default path):
```ts
/** Like complete(), but routes to the given targets instead of #primary/#fallback.
 *  Reuses the SAME budget/audit/abort/circuit machinery. */
async completeWith(primary: ModelTarget, fallback: ModelTarget | undefined,
                   req: InferenceRequest): Promise<InferenceResponse>;
```
Refactor `complete()` to delegate: `return this.completeWith(this.#primary, this.#fallback, req);`
so there's ONE code path, two entry points. Preserve `trustedBaseUrls`
enforcement for the passed targets (same check as the constructor).

### 3e. Wire agent-loop
At each `this.#router.complete({ messages, ... })` main-loop call: if
`brain?.enabled`, compute `const { primary, fallback } = brain.route({ text, hasImages, offline })`
once per user turn (not per tool-iteration — pick the model for the turn), and
call `this.#router.completeWith(primary, fallback, req)`. Else unchanged.
`offline` = `router.isLocalOnly` / no cloud target reachable (reuse the existing
`isLocalOnly`-style getter you find in the router).

---

## 4. Config & storage

`~/.feral/brain.json` (headless reads it; desktop/wizard write it later). Absent →
Brain Stack disabled (opt-in). Shape = `BrainConfig` (3c) serialized. Seed a
sensible default registry from the user's already-configured providers (BYOK has
openai/anthropic/google/groq/mistral/deepseek/openrouter/minimax/nvidia/… — grep
`crates/feral-core/src/byok.rs` for the current list) + the local model. Ship a
`brain.example.json` in `FeralAgent/` documenting the shape.

Env escape hatch for headless testing: `FERAL_BRAIN=1` to force-enable using
`brain.json`.

---

## 5. Slices (each: implement → test → `ls`/read back → report)

- **S1** `capability-registry.ts` + types + `available()` filter. Unit tests:
  filtering by health + creds.
- **S2** `task-classifier.ts` heuristic table. Unit tests: one per category incl.
  images→vision, offline→offline, code→coding, split precedence order.
- **S3** `brain-stack.ts` scoring + `route()`. Unit tests: budget vs quality pick
  differently; override honored; offline forces local; open circuit skips model;
  "nothing available" throws.
- **S4** `inference-router.ts` `completeWith` refactor (complete() delegates).
  Regression: existing router tests still pass; new test that completeWith honors
  trustedBaseUrls.
- **S5** agent-loop wiring behind `brain?.enabled`; `brain.json` load +
  `FERAL_BRAIN` env. Test: disabled → identical to today's path.
- **S6** generalize `CircuitBreaker` to key by target id; feed open/closed into
  `route()`; on `completeWith` failure record the breaker. Test: primary trips →
  next turn routes around it.
- **S7** Personality-invariance test: two turns forced to different models return
  the SAME system prompt/persona (soul unchanged).

Keep each slice a commit. `bun test` green after each. Rebuild the sidecar
(`bun run build` + copy to `src-tauri/binaries/` — see [[sidecar-binary-flow]])
only when you need a live smoke; unit tests don't need it.

---

## 6. Non-goals (do NOT build here)

- The setup **wizard** (Stage 3 — later; MVP wizard only).
- **NPM** packaging (Stage 4 — after launch).
- Hardware **tier recommendation** (Stage 5 — trivial, later).
- CLI surfacing (`feral brain` / `feral provider`) — needs a Rust endpoint over
  sidecar state; separate slice after the engine works.
- A local-LLM **classifier** — heuristic is enough for MVP.
- Streaming target-switching mid-response — pick per turn, not per token.

---

## 7. Definition of done (Stage 1)

`bun test` green; with `brain.json` present + `FERAL_BRAIN=1`, a coding prompt
routes to the coding-strong model, a `simple` prompt to the cheap/local one, an
image to the vision model, and killing the primary provider's health re-routes
the next turn — all while the persona stays "Feral". Report the commit SHAs and
which files you wrote (with `ls` proof).
