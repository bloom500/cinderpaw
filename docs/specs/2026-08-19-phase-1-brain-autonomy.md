# Phase 1 — Brain Autonomy

**Date:** 2026-08-19 · **Type:** implementation spec · **Status:** ready to implement

**Evidence baseline:** `docs/ui/2026-08-19-brain-current-state.md`
**UX contract:** `docs/ui/2026-08-19-ux-contract.md`

## Objective

On a fresh Cinderpaw installation, Brain Stack is active by default and selects an
appropriate available model for every turn, without the user writing
`~/.cinderpaw/brain.json` and without the user picking a model to send a message.

This is an **activation and hardening pass**, not a Brain redesign. The routing
architecture exists, is wired into the agent loop, and is covered by 1327 lines
of passing tests. Phase 1 supplies the configuration the boot path never built,
and makes the failure modes truthful.

## Non-goals

Explicitly out of scope. Touching any of these is a scope violation.

- Redesigning `BrainStack`, the scorer, or `REQUIREMENTS`.
- Rewriting `classify()` or the category taxonomy.
- Introducing a second capability model alongside the existing one.
- Capability installation (Phase 2) or connector/OAuth work (Phase 3).
- Enumerating every installed local model — see *Deferred seam* below.
- Any UI redesign beyond removing the model dead-end and rendering the two new
  states this spec requires.

## Design decisions

### D1 — The default registry is derived from the router's configured targets

The sidecar knows at most two model targets: `#primary` and `#fallback`
(`egress/inference-router.ts:157-158`), from `InferenceConfig`. There is no
inventory of installed models inside the agent process.

Phase 1 therefore derives `BrainModel[]` from those targets. On a typical
install that is local + cloud — exactly the two-entry shape
`brain.example.json` demonstrates, and exactly the case where routing has real
value: local for `simple`/`speed`, cloud for `reasoning`/`vision`.

With a single configured target the registry has one entry and routing
correctly selects the only model. This is degenerate but honest, and it still
removes the "Brain is null for everyone" state.

**Rejected:** host-side enumeration of all installed models. It requires a new
Tauri command, a new sidecar message, and config plumbing — a Phase 1.5 slice
with its own spec. The derivation seam below is built so that slice only has to
supply a longer array.

### D2 — Capability values come from a model-family table, conservatively

New module `src/brain/model-profiles.ts`. A pure function:

```
profileFor(target: ModelTarget): { capabilities, cost, local }
```

It matches `target.model` against a table of known families — qwen, llama,
deepseek, mistral, phi, gemma, claude, gpt, gemini — and falls back to a
conservative unknown profile.

Rules the table must obey:

- **Unknown models score mid on everything except `tool_use`-adjacent
  behaviour, where they score low.** An unproven model is not handed the work
  most likely to fail silently. Failing toward "Cinderpaw used the cloud model" is
  correct; failing toward "Cinderpaw promised and could not deliver" is not.
- `local` is derived from the base URL using the router's existing
  `#isLocalHost` logic, not guessed from the model name.
- `cost` stays the existing `1 | 2 | 3` ordinal. Real per-token pricing is out
  of scope.

The table is data, hand-written once, with a comment recording that runtime
observation is the intended later evidence source (the circuit breaker already
keys on `BrainModel.id`).

### D3 — `brain.json` still wins when present

Precedence: an existing `brain.json` is loaded exactly as today, including
`enabled: false`. Only when the file is absent does the derived config apply,
with `enabled: true` and `mode: "balanced"`.

This means no existing user's deliberate configuration changes behaviour, and
every user without a file gains routing.

### D4 — The zero-model reply is product copy, not model output

You cannot ask a model to explain that there is no model. The composer stays
enabled (UX contract), the message is accepted, and the reply is **deterministic
copy emitted by the host**, clearly the product speaking:

> I need a model before I can do that. I can download a small local one that
> works offline, or use an API key if you have one.

with two actions: **Download a model** → Models, **Add a key** → Settings.

`NoModelEmptyState` — which today replaces the composer entirely — is removed as
a blocking screen. Its two buttons survive as the actions on this reply.

### D5 — One event carries every routing decision

New `OutboundEvent` variant, following the precedent set by `rate_limited`
(added because "a silent gap of several seconds is indistinguishable from a hung
agent" — `types.ts:1375`):

```
| { type: "model_routed"; sessionId: string;
    provider: string; model: string;
    reason: "brain" | "fallback" | "only_candidate";
    category?: string; detail?: string; traceId?: string }
```

One event covers success and failure. It gives the UI the routed model for the
badge and the "Why?" content for free, without a second channel.

## Required behaviour

### B1 — Activation

```
Fresh install · no brain.json · no manual setup
        ↓
loadBrainConfig() → null
        ↓
deriveDefaultConfig(router targets)  ← new
        ↓
BrainStack constructed · enabled · mode "balanced"
```

`boot.ts:987` currently reads `const brain = brainCfg ? new BrainStack(...) : null`.
After Phase 1, `brain` is null only when there are zero configured targets.

### B2 — Model selection

Unchanged from today's implementation. `classify` → `REQUIREMENTS` →
`available(isHealthy)` → score → primary + fallback. Phase 1 adds no scoring
logic.

### B3 — No usable model

Deterministic, defined at each layer:

| Condition | Behaviour |
|---|---|
| Zero configured targets | `brain` is null; composer stays enabled; D4 reply on send |
| Targets exist, none configured (empty key) | Same as above — an unusable model is not a model |
| Targets exist, all unhealthy (breaker open) | `BrainError`; explicit fallback per B4, not silence |

### B4 — Brain failure — the invariant

**No silent fallback.** A fallback may happen; it may not be hidden.

`agent-loop.ts:2239` today catches `BrainError`, writes `console.warn`, and
returns `null`. After Phase 1 that path also emits `model_routed` with
`reason: "fallback"` and a human-readable `detail`.

The user-visible surface is one quiet line, not an error toast:

> Automatic model selection was unavailable, so I used your default model. **Why?**

`Why?` expands to the real reason. Developer text (`BrainError: ...`) belongs
behind that expansion, never in the primary line — per the UX contract's
vocabulary rules and progressive-disclosure rule.

## Files

| File | Change |
|---|---|
| `CinderpawAgent/src/brain/model-profiles.ts` | **new** — family table + `profileFor()` |
| `CinderpawAgent/src/brain/brain-config.ts` | add `deriveDefaultConfig()`; file still wins |
| `CinderpawAgent/src/boot.ts` | build Brain from derived config when no file |
| `CinderpawAgent/src/core/agent-loop.ts` | emit `model_routed` on both paths |
| `CinderpawAgent/src/types.ts` | the `model_routed` variant |
| `frontend-react/src/components/chat/EmptyStates.tsx` | remove the blocking dead-end |
| `frontend-react/src/components/chat/ChatInput.tsx` | drop `noModel` placeholder block |
| `frontend-react/src/lib/i18n.ts` | new EN + RO copy for D4 and B4 |
| tests | see below |

No changes to `brain-stack.ts`, `capability-registry.ts`, or
`task-classifier.ts`. If implementation appears to require one, stop and revise
this spec rather than editing them.

## Acceptance criteria

1. Fresh boot with no `brain.json` and one configured target → Brain active,
   that model selected, turn executes.
2. Fresh boot with local + cloud targets → a `coding` prompt and a `simple`
   prompt route to different models.
3. `brain.json` present with `enabled: false` → Brain stays off. No regression.
4. Zero configured targets → composer enabled, D4 reply rendered with both
   actions, no blocking screen.
5. Cloud target with an empty API key → treated as unconfigured, not selected.
6. All candidates unhealthy → `model_routed` with `reason: "fallback"` is
   emitted; nothing is silent.
7. All 1327 existing Brain test lines still pass, unmodified.
8. `./scripts/verify.sh` passes.

## Tests to add

- `deriveDefaultConfig` produces a valid `BrainConfig` from one target, from
  two, and from zero.
- `profileFor` returns the family profile for known model strings and the
  conservative profile for an unknown one.
- Boot-level: no `brain.json` → `brain !== null`.
- Boot-level: `brain.json` with `enabled: false` → Brain off.
- `agent-loop` emits `model_routed` on the success path and on the catch path.
- **Regression, documenting current behaviour, not fixing it:** `classify()`
  never returns `"multilingual"` for any input.

## Known issue — `multilingual`

`Category` declares `multilingual`, `REQUIREMENTS` weights it at `1.0`, the
scorer is tested against it, and `classify()` cannot produce it
(`brain-current-state.md` §5). This is a documented routing defect.

Phase 1 must not make it worse and adds the regression test above to pin the
current behaviour. Correcting the classifier is a separate, later change.

## Deferred seam

Full model discovery — the host enumerating every installed local model and
every configured provider key, and handing the sidecar a complete registry — is
Phase 1.5. `deriveDefaultConfig()` is the single function that slice replaces;
nothing else in Brain needs to know where the array came from.
