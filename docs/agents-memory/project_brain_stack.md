# Brain Stack — Slice 1 done, Slice 2 plan, architecture rules

## Slice 1 (DONE — MiniMax)

**Files:**
- `FeralAgent/src/brain/capability-registry.ts` (174 lines, on disk)
- `FeralAgent/tests/capability-registry.test.ts` (20 tests, all green)

**Exports:** `Capability`, `Category`, `BrainModel`, `CapabilityRegistry`,
`isConfigured`, `normalizeCapabilities`.

**Contract realised:**
- `BrainModel.target` reuses the **real** `ModelTarget` from `src/types.ts:420`
  (provider/model/baseUrl/apiKey) — no parallel `BrainModelTarget` type.
- `CapabilityRegistry.available(isHealthy)` filters by
  `isConfigured(model) && isHealthy(model.id)`.
- `isConfigured(local)` returns `true` by definition (no API key needed);
  cloud targets need a non-empty `apiKey`. Empty string = "key was cleared"
  = unconfigured (would 401). This is the **renamed** version of the
  original `hasCreds()` — the broader name covers future provider
  families (Ollama, llama.cpp, LM Studio, HuggingFace endpoint, OpenAI-
  compatible) where "configured" is the right predicate.

**Tests:**
- `bun test tests/capability-registry.test.ts` → 20/0/25
- Full suite `bun test` → 1672/0/5 (no regressions)
- `bunx tsc --noEmit` clean

## Slice 2 (DONE — MiniMax)

**Files:**
- `FeralAgent/src/brain/task-classifier.ts` (171 lines, on disk)
- `FeralAgent/tests/task-classifier.test.ts` (48 tests, all green)

**Exports:** `Classification`, `ClassifierInput`, `classify`,
`LONG_PROMPT_CHARS` (=1500), `CONFIDENCE` (binary/keyword/fallback),
`CODE_PATTERNS`, `REASONING_PATTERNS`, `CREATIVE_PATTERNS` (all
`readonly RegExp[]`).

**Contract realised:**
- Pure function — no I/O, no extra LLM call, no side effects.
- Heuristic order exactly as brief §3b: vision > offline > coding >
  reasoning > creative > simple. Reordering silently changes routing
  for every multi-rule prompt — precedence tests in
  `tests/task-classifier.test.ts` are the regression guard.
- Word boundaries (`\b`) on single-token keywords to reject obvious
  false positives: `showy` does NOT trigger `why`, `improve` does NOT
  trigger `prove`, `dysfunction` does NOT trigger `function`. Tests
  assert each of these explicitly.
- Confidence bands are strictly ordered `binary (0.95) > keyword (0.75)
  > fallback (0.5)` and stay in [0, 1]. Downstream scoring uses these
  as tiebreakers — only the relative ordering is load-bearing.
- Multi-word phrases ("step by step", "stack trace", "write a story")
  use a right-side boundary only so they can land mid-sentence.
- Plurals handled where natural: `poems?`, `lyrics?`. `imagine` stays
  strict (boundary on both sides) — "imagined" does NOT trigger.

**Test surface (48 tests):**
- One test per category (11 tests)
- Precedence (8 tests) — vision > offline > coding > reasoning > creative > simple
- Word-boundary correctness (8 tests) — improve/showy/dysfunction/etc.
- Case-insensitivity (3 tests)
- Long-prompt threshold boundary (2 tests) — exactly N vs N+1
- Edge cases (4 tests) — empty, whitespace, punctuation, non-ASCII
- Confidence bands (8 tests) — each rule returns its expected band; bands are ordered
- Heuristic table shape (4 tests) — patterns are RegExp, LONG_PROMPT_CHARS is positive int

**Verification:**
- `bun test tests/task-classifier.test.ts` → 48/0/76
- Full suite `bun test` → 1720/0/5 (was 1672/0/5; +48 new tests)
- `bunx tsc --noEmit` clean

**Slice 2 doesn't touch:** `inference-router.ts` (S4), `agent-loop.ts`
(S5), `circuit-breaker.ts` (S6), `CapabilityRegistry` itself. The
classifier imports `Category` from S1 and nothing else.

## Slice 3 (DONE — MiniMax)

**Files:**
- `FeralAgent/src/brain/brain-stack.ts` (376 lines, on disk)
- `FeralAgent/tests/brain-stack.test.ts` (43 tests, all green)

**Exports:** `Mode`, `MODE_WEIGHT`, `LOCAL_BONUS`, `REQUIREMENTS`,
`BrainConfig`, `RouteResult`, `RouteInput`, `BrainError`, `BrainStack`,
`scoreModel`, `pickTopScore`.

**Contract realised:**
- Scoring formula (brief §3c) implemented literally:
  `Σ w·c − modeWeight·cost + (budget && local ? LOCAL_BONUS : 0) + 0.5·confidence`
- `REQUIREMENTS` covers all 7 categories with weights in [0, 1]:
  - `coding: { coding: 1.0, reasoning: 0.5 }`
  - `vision: { vision: 1.0 }`
  - `reasoning: { reasoning: 1.0 }`
  - `creative: { multilingual: 0.4, reasoning: 0.3, speed: 0.2 }`
  - `simple: { speed: 1.0 }`
  - `multilingual: { multilingual: 1.0 }`
  - `offline: { speed: 0.5 }` (any working model; speed is just tiebreaker)
- `MODE_WEIGHT`: budget=2.0, balanced=1.0, quality=0
- `LOCAL_BONUS = 1.5` (applied only in budget mode)
- `scoreModel` is pure + exported; the formula can be unit-tested without going through route()
- `BrainStack.route()`:
  1. classifies input → Category + confidence
  2. filters registry to `isConfigured(m) && stateOf(id) !== "open"`
  3. if `overrides[category]` is available → primary
  4. else if category === "offline" AND `offlineModelId` is available → primary
  5. else → top scorer
  6. fallback = top scorer of "others", preferring different provider family
  7. throws `BrainError` (never silent) when no candidate is available
- `BrainError.message` includes the category name + reason for debuggability

**Health filter uses `stateOf()` (read-only) — no side effects.** The
router's `completeWith()` (S4) does the side-effecting `breaker.check()`
that marks probes in flight. BrainStack just decides WHERE to aim.

**Override / offline unavailable = fall through to scoring.** Better
to answer with something working than to refuse the turn. A logger
wired in S5 will surface these config bugs.

**Test surface (43 tests):**
- REQUIREMENTS table shape (2) — all categories covered, weights in [0,1]
- MODE_WEIGHT (3) — budget > balanced > quality
- scoreModel — pure formula (10) — per-category winner, budget penalty, quality ignores cost, local bonus only in budget, confidence tiebreaker
- pickTopScore (4) — empty throws, single wins, mode flips choice
- route() — happy paths (6) — coding/vision/reasoning/simple/offline/multilingual prompts pick the right model
- route() — fallback (4) — undefined for single, different-provider preferred, same-provider as last resort, primary ≠ fallback
- route() — overrides (2) — pinned when available, falls through when not
- route() — offline force (3) — forces when available, falls through when not, ignored when category isn't offline
- route() — health (5) — open circuit skips, all unhealthy throws, unconfigured filtered, BrainError message includes category
- construction (3) — mode getter, registry getter, duplicate ids throw

**Verification:**
- `bun test tests/brain-stack.test.ts` → 43/0/96
- Full suite `bun test` → 1763/0/5 (was 1720/0/5; +43 new)
- `bunx tsc --noEmit` clean

**Slice 3 doesn't touch:** `inference-router.ts` (S4 = add completeWith),
`agent-loop.ts` (S5 = wire behind brain?.enabled), `circuit-breaker.ts`
(S6 = key by id; currently keyed by tool name, but the API is string-keyed
so BrainStack works today with BrainModel.id as the key).

**Slice 4 plan — router seam (next, Opus):**
- Add `completeWith(primary, fallback, req)` to `InferenceRouter` — mirror
  `complete()` but with explicit targets instead of `#primary`/`#fallback`.
- Refactor `complete()` to delegate to `completeWith(this.#primary, this.#fallback, req)`.
- Preserve `trustedBaseUrls` enforcement on the passed targets (same check as constructor).
- Regression: existing `tests/inference-router.test.ts` still passes.
- New test: `completeWith` refuses a target outside `trustedBaseUrls` before fetch.

## Slice 4 (DONE — MiniMax)

**Files:**
- `FeralAgent/src/sandbox/inference-router.ts` — `complete()` refactored to
  delegate to the new `completeWith(primary, fallback, req)` method.
  Same trusted-URL guard as the constructor runs at call time.
- `FeralAgent/tests/inference-router.test.ts` — +8 tests for the seam
  (uses passed targets, refuses untrusted primary, refuses untrusted
  fallback, refuses-before-budget, regression on `complete()`).

**Contract realised:**
- One code path, two entry points: `complete()` and `completeWith()`
  share the full fetch / budget / audit / abort machinery.
- `complete(req)` is now exactly `completeWith(this.#primary, this.#fallback, req)`.
- `completeWith(primary, fallback, req)`:
  1. validates `primary` and `fallback` against `this.#trusted` (same
     loop as the constructor); throws `InferenceError` + writes a
     `blocked` audit row if any passed target is not trusted
  2. runs the budget gate (unless `skipBudgetCheck`)
  3. installs the per-session AbortController
  4. tries primary via `#callTarget`; on failure, tries fallback
  5. records usage, writes success audit, returns
- Defense-in-depth retained: `#callTarget` still re-checks trusted
  URLs at fetch time. The constructor-style check in `completeWith`
  just fails fast with a cleaner stack and stops the budget / abort
  machinery from doing pointless work for an obviously-bad target.

**Test surface (8 new tests):**
- `completeWith` uses the PASSED primary, not `#primary` (verified by URL inspection)
- `completeWith` uses the PASSED fallback when primary fails (verified by call sequence)
- `completeWith` with no fallback: primary failure throws `InferenceError` + error audit row
- `completeWith` refuses untrusted primary (`blocked` audit, no fetch)
- `completeWith` refuses untrusted fallback (same)
- `completeWith` refuses BEFORE budget check runs (order matters)
- `complete()` regression: still routes to `#primary`, still falls back to `#fallback`

**Verification:**
- `bun test tests/inference-router.test.ts` → 17/0/48 (was 9/0/26; +8 new)
- Full suite `bun test` → 1771/0/5 (was 1763/0/5; +8 new)
- `bunx tsc --noEmit` clean

**Slice 4 doesn't touch:** agent-loop (S5 = wire `brain?.enabled` +
`brain.route()` + `router.completeWith()`), circuit-breaker (S6 =
generalise the key — already string-keyed, BrainStack uses
`BrainModel.id` today), CapabilityRegistry / Classifier / BrainStack.

## Slice 5 (DONE — MiniMax) — the bridge slice

**Files touched:**
- `FeralAgent/src/sandbox/inference-router.ts` — added `cloudReachable`
  getter (refactored `isPrimaryLocal` to share `#isLocalHost`)
- `FeralAgent/src/brain/brain-config.ts` — NEW. `loadBrainConfig()` +
  `defaultBrainPath()`. Pure I/O, testable with `opts.brainPath` /
  `opts.env` overrides.
- `FeralAgent/src/core/agent-loop.ts` — added `#brain: BrainStack | null`;
  new constructor param; `#routeForTurn()` helper computes the
  routing decision once per user turn (top of `#handle`); `#run` and
  `#complete` thread `routeTargets` so every router call in the turn
  uses the same Brain-picked targets.
- `FeralAgent/src/index.ts` — wired `loadBrainConfig()` + `new BrainStack()`
  + passes `brain` to `AgentLoop`. BrainStack gets its own CircuitBreaker
  instance (separate namespace from the tool breaker; S6 will generalise
  the breaker key).
- `FeralAgent/tests/inference-router.test.ts` — +5 `cloudReachable` tests.
- `FeralAgent/tests/brain-config.test.ts` — NEW. 19 tests covering
  opt-in via file, FERAL_BRAIN env, shape validation, defaultBrainPath.
- `FeralAgent/tests/agent-loop-brain.test.ts` — NEW. 6 end-to-end tests:
  brain=null regression, brain picks coding-strong for coding prompts,
  budget mode picks local, BrainError falls through to default path,
  routing decision is computed ONCE per turn (not per iteration),
  offline hint works.

**Contract realised (brief §3e + §4):**
- `AgentLoop.constructor` accepts an optional 10th arg `brain: BrainStack | null`
- `brain.route({text, hasImages, offline})` is called ONCE at the top
  of `#handle()`; the resulting `{primary, fallback}` pair is threaded
  through every iteration of `#run`'s tool-call loop (main call +
  budget-recovery retry)
- When brain is null OR `brain.route()` throws (BrainError, no candidates):
  agent-loop falls back to `router.complete()` with `#primary`/`#fallback`.
  A misconfigured Brain never breaks a turn.
- `offline` hint is computed at `#routeForTurn()` as
  `router.isPrimaryLocal && !router.cloudReachable`. `cloudReachable` is
  true iff primary OR fallback is on a non-loopback host.
- `brain.json` load + `FERAL_BRAIN=1` env escape hatch:
  - absent file, no env → `null` (Brain disabled, today's path)
  - absent file + `FERAL_BRAIN=1` → throws (explicit request, no config)
  - present file + `enabled:false` + no env → `null` (file's opt-out)
  - present file + `enabled:false` + `FERAL_BRAIN=1` → `enabled:true` (forced)
  - present file + `enabled:true` → returned as-is

**Open question (deferred):** the current offline path forces the
"offline" Category regardless of the user's prompt (a coding prompt
on a local-only router gets routed via the offline category's
speed-based pick, not coding-strong even if it's available). This
matches the brief literally (S2 maps `offline:true` → Category
"offline") but it can pick the "wrong" model for the prompt. A
future slice may add a "force offline model but classify normally"
hint — out of scope for S5.

**Verification:**
- `bun test tests/inference-router.test.ts` → 22/0/57
- `bun test tests/brain-config.test.ts` → 19/0/26
- `bun test tests/agent-loop-brain.test.ts` → 6/0/13
- Full suite `bun test` → 1801/0/5 (was 1771/0/5; +30 new tests)
- `bunx tsc --noEmit` clean

**Slice 5 doesn't touch:** the circuit-breaker itself (S6 will
generalise the key — BrainStack currently passes a fresh breaker
instance, separate from the tool breaker's namespace). No new
`OutboundEvent` kinds were needed (brain routing is transparent to
the event stream). No changes to Classifier or CapabilityRegistry.

**Slice 6 plan — circuit-breaker key generalisation (next, Opus):**
- Today: `CircuitBreaker` is keyed by string. ToolRegistry keys by
  tool name; BrainStack keys by `BrainModel.id`. They live in
  separate namespaces because they're separate instances.
- S6: collapse to one shared breaker instance keyed by a namespaced
  string (e.g. `tool:read_file` vs `brain:claude-sonnet-4`). Or keep
  them separate but document the namespace contract. The brief says
  "generalise the breaker to key by target id; feed open/closed into
  route(); on `completeWith` failure record the breaker."
- After S6: BrainStack's `stateOf(id)` checks feed back into actual
  circuit health (failed Brain-routed calls trip the breaker; next
  turn routes around the failed model automatically).

## Roadmap beyond MVP — GPT 5.5 strategic direction (captured 2026-07-03)

GPT 5.5 reviewed S1-S3 and flagged the long-term direction. **None of
this is in the brief — do NOT build it without a separate design pass.**

### Already in place from the brief

- **Capability vectors 0..10**: `BrainModel.capabilities` from S1 is
  already a per-capability score vector. The data structure supports
  fine-grained reasoning — the current MVP just uses it through the
  category-level `REQUIREMENTS` shortcut.
- **Weighted-vector scoring**: `scoreModel` in S3 already does
  `Σ w·c − mw·cost + bonus`. Brain already maximises a scalar from
  vectors — not a string comparison.
- **Tunable weights**: `LOCAL_BONUS`, `CONFIDENCE_WEIGHT`, `MODE_WEIGHT`
  are already exported and independent. Config-driven tuning is a
  matter of wiring `brain.json`.

### What's missing (post-MVP roadmap)

1. **Dynamic requirement extraction.** Today: classifier maps text
   → 1 Category → 1 fixed REQUIREMENTS vector. Tomorrow: classifier
   should emit signals (`requires_long_context`, `requires_json`,
   `requires_tool_use`, `requires_low_cost`, …) and a composer turns
   them into a custom REQUIREMENTS vector per task. This breaks the
   one-category-one-vector shortcut.

2. **Multi-step execution plans.** Today: Brain picks 1 model per
   turn. Tomorrow: a planner decomposes goals into {planner, coder,
   reviewer, tester} roles, each potentially on a different model.
   This is the Sakana direction GPT 5.5 referenced.

3. **Policy Engine as a distinct layer.** Today: Policy = Router
   (BrainStack does both: classify → score → choose). Tomorrow:
   ```
   Goal
    ↓
   Classifier        (S2, done)
    ↓
   Brain Policy      (NEW — goal decomposition, role selection)
    ↓
   Execution Plan    (NEW — list of {role, model, prompt_template})
    ↓
   Router            (S4 done; called once per plan step)
   ```
   This requires the agent-loop to grow a plan-execution loop and
   BrainStack to split into "Policy" + "RoleRouter".

4. **Provider Health beyond binary.** Today: `CircuitBreaker` only
   knows closed / open / half_open. Tomorrow: a `HealthManager`
   (per the four-responsibility split) tracks latency, rate-limit
   quota, daily quota, last error — richer signals the scorer can
   use to prefer a slow-but-cheap model over a fast-but-rate-limited
   one.

### Why we're NOT building this now

- The brief (Faza 4.6) is explicit about MVP scope: category-based
  heuristic, no LLM in the classification loop, single-model-per-turn.
- The user's decision (2026-07-03) was to continue with the brief's
  S4-S7 (router seam, agent-loop wiring, breaker key generalisation,
  personality-invariance test) — NOT to pivot to Policy Engine.
- The architecture is *compatible* with the roadmap: capability
  vectors, weighted scoring, registry/router separation, health
  observation all point the right way. Adding the policy layer
  later is a matter of composing existing modules, not refactoring.

### When to revisit

- After S7 (personality-invariance test) is green, the user will
  decide whether to ship Brain Stack MVP or extend into policy mode.
- The four-responsibility split (Registry=Data / Router=Policy /
  Health=Observation / Cost=Optimisation) is the discipline to keep
  during S5-S7 — if any of those slices starts bleeding into the
  others, that's the signal to stop and design the Policy Engine
  before going further.

## Strategic direction — Headless UX first (revisited 2026-07-03 after GPT 5.5 review)

GPT 5.5 reviewed the trajectory after S4 and **rejected** the
"Policy Engine next" framing. The current consensus priority is the
end-to-end **Headless UX experience** — Brain Stack is a means, not
an end, until a user can install Feral in 5 minutes and talk to the
same agent from terminal + Discord.

### Priority list (consensus, not in code yet)

1. `feral setup` — wizard that installs/configures everything
2. `feral gateway start` — daemon (already exists)
3. `feral chat` — TUI: streaming, tool calls, status line, dream events, model switching
4. `feral attach` — `docker attach`-style: connect to a running gateway, open TUI, no new process
5. `feral models` / `feral providers` / `feral brain` — admin commands
6. Hugging Face local installer — model acquisition
7. Discord / Telegram / WhatsApp connectors — transports

"Discord becomes transport, not feature" — the brain / memory /
dreams are the product; Discord is one of N surfaces.

### Why S5 is the bridge (insight — don't skip)

Brain Stack in S1-S4 is an **engine**. It is invisible to the user.
S5 (`agent-loop` wiring behind `brain?.enabled`) is what makes the
engine **felt** through every interface — desktop app, future TUI,
future Discord. S5 is the prerequisite to a brain-aware `feral chat`.

If we skip S5 and build `feral chat` first, the TUI is the same
product as today minus the GUI. The user will ask "ok but where's
the brain?". S5 is what makes Brain Stack felt everywhere.

### Recommended execution order

1. **S5-S7 (finish the brief)** — agent-loop wiring, breaker-key
   generalisation, personality invariance test. After S5, brain is
   felt through the existing UX.
2. **`feral chat` TUI** — thin Bun client over the existing inbound/
   outbound JSON protocol. Inherits brain-awareness from S5 for free.
3. **`feral attach`** — requires gateway IPC (Unix socket /
   WebSocket). Like `tmux attach`: same brain, same memory, same LoRA.
4. **`feral models` / `feral providers` / `feral brain`** — thin admin
   commands that read what already exists (BYOK config, registry).
5. **Hugging Face installer** — `feral models install <hf-repo>`:
   download + register + report. Substantial but independent.
6. **Discord / Telegram / WhatsApp** — additional transports.

### Why this order hits GPT 5.5's 5-minute-install goal

- S5-S7 make Brain Stack feel like a feature, not a refactor.
- `feral chat` is small (~300 lines Bun) once S5 is done.
- `feral attach` is small once gateway exposes IPC.
- Admin commands are wrappers around existing config.
- Transports (Discord etc.) are plug-ins on the existing protocol.

Skipping S5 to do `feral chat` first gets us a TUI without the brain —
the opposite of the goal. The order above is the shortest path to
"install Feral, talk to it from terminal and Discord, same brain".

### Open question for S5: how to compute `offline`

The brief says "`offline` = `router.isLocalOnly` / no cloud target
reachable". The router today has `isPrimaryLocal` (URL host check)
but no `isLocalOnly` getter that considers the fallback too. Three
options:

(a) `router.isPrimaryLocal` — simple; forces local even when fallback is cloud
(b) `router.isPrimaryLocal && !router.cloudReachable` — correct; needs a new getter
(c) pass offline as a hint from the host (config / env) — most explicit

Decision deferred to the S5 implementation conversation.

## Architecture — separation of responsibilities (DO NOT BLUR)

The four pieces of Brain Stack must stay separate:

| Module | Responsibility | Owns |
|---|---|---|
| **CapabilityRegistry** | Data. List of models. | `BrainModel[]` — that's it. No policy, no observation, no optimisation. |
| **BrainRouter** | Policy. Pick a model for a request. | Classification → requirements → candidates → scoring → winner. |
| **HealthManager** | Observation. What we know about each provider *right now*. | Status (healthy / degraded / down), latency, rate-limit, daily quota, last error. |
| **CostManager** | Optimisation. What's the cheapest way to satisfy a request. | Cost per provider, mode (budget/balanced/quality), local bonus. |

If `CapabilityRegistry` ever starts owning a `CircuitBreaker`, picking a
winner, or applying a cost weight — something is wrong. Push the logic
down to the right module. Six months from now you should still be able
to read each module and know its job from the filename.

## Provider Health is more than "up/down"

Slice 6 will generalise `CircuitBreaker` to key by `BrainModel.id`.
HealthManager should grow to track **per-provider**:

- `status`: `healthy | degraded | down`
- `latencyMs`: rolling p50/p95
- `rateLimitedUntil`: epoch ms when 429 cleared
- `dailyQuotaRemaining`: 0..1 (1 = full day left)
- `lastError`: most recent failure reason

The breaker stays binary for "is it sick right now". HealthManager
answers richer questions — "is it slow?" "is it expensive?" "is the day
almost over?". BrainRouter composes all four managers; it doesn't own
any of them.

## Slice 2 plan — task classifier

The flow Brain Stack will eventually execute, top to bottom:

```
Request
  → Classifier                (text + images → Category)
  → Intent                    (Category + confidence)
  → Capability Requirements   (Category → Record<Capability, number>)
  → Capability Registry       (candidates by configured + healthy)
  → Health                    (drop unhealthy, prefer low-latency)
  → Budget                    (mode-aware cost weighting)
  → Availability              (final filter)
  → Winner                    (BrainRouter.route() → ModelTarget)
  → Inference                 (InferenceRouter.completeWith())
```

**Slice 2 only does the first arrow:** `classify(input)` → `Category`.

Contracts (from `docs/2026-07-03-brain-stack-minimax-brief.md` §3b):

```ts
export interface Classification { category: Category; confidence: number; }

export function classify(input: {
  text: string;
  hasImages: boolean;
  offline: boolean;
}): Classification;
```

**Heuristic order (first match wins):**
1. `hasImages` → `"vision"`
2. `offline` → `"offline"`
3. Code fences / verbs (`refactor|debug|compile|stack trace|regex|function`) → `"coding"`
4. Reasoning cues (`prove|derive|step by step|analyze|why`) **OR** long prompt → `"reasoning"`
5. Creative (`write a story|poem|lyrics|imagine`) → `"creative"`
6. Otherwise → `"simple"`

Keep the keyword sets in a table so they're testable and tunable.

**Non-goal for Slice 2:** a local-LLM classifier. Heuristic only.

**Test surface (one per category, plus precedence):**
- `hasImages:true` → vision (regardless of text)
- `offline:true` → offline (overrides everything except images)
- code verb → coding
- reasoning cue → reasoning
- long prompt (e.g. >1500 chars) → reasoning
- creative cue → creative
- short factual "what time is it" → simple
- precedence: vision beats offline; offline beats coding
- pure punctuation / empty string → simple

## Constraints carried forward

- `BrainModel.target` is the **real** `ModelTarget` — slice 2 must not
  invent a parallel type.
- Registry stays zero-deps on the breaker; classifier is zero-deps on
  the registry. Each slice only imports what it needs.
- New outbound `OutboundEvent` kinds go in `src/types.ts`; the sidecar
  handler in `index.ts` no longer needs the cast when the type is in
  the union (per pinned rule in AGENTS.md).
- Every file written gets `ls`/read back. Every slice a commit.

## Files NOT to touch in Slice 2

- `src/sandbox/inference-router.ts` — that's slice 4 (the seam is `completeWith`).
- `src/core/agent-loop.ts` — slice 5.
- `src/sandbox/circuit-breaker.ts` — slice 6 (generalise the key).
- Anything in `src/rsi/` — BRSI is a separate engine, read
  `project_brsi_evolution.md` before touching any of it.