# Bulletproof inference performance enforcement — design

**Date:** 2026-06-28
**Status:** Approved (design only; implementation delegated to MiniMax M3)
**Branch:** feat/reactive-pixel-tree

## Problem

A user can stare at "Thinking…" for 5-10 minutes per prompt and get either an
error or, at best, a slow answer — on both local and cloud models. Root causes,
measured in the current code:

- **Chat path (Rust local):** `inference.rs::run_inference` has **no
  time-to-first-token (TTFT) deadline and no total wall-clock deadline**.
  Generation runs in `spawn_blocking` with only a manual `stop: Arc<AtomicBool>`
  (set by the user clicking Stop). `chatStream.ts` has **no client-side
  watchdog** — it waits on `feral://token|stream-done|stream-error` forever, so a
  wedged backend = infinite "Thinking".
- **Agent path (sidecar):** `inference-providers.ts::idleAbortController`
  enforces an *idle-between-tokens* timeout only — **300 s** for loopback/local,
  `CLOUD_IDLE_MS` (60 s) for cloud. No TTFT deadline, no total deadline. 300 s of
  no-token prefill = the 5-minute hang before it finally errors.
- **No health/staleness check** on either path: a crashed/unloaded local engine
  or a stale loaded model just hangs.
- **No progress feedback during prefill:** "Thinking" is a static black box —
  the user can't tell working-but-slow from wedged.

The recently shipped tool-drawer reduces prompt size (faster prefill) but
*enforces* nothing.

## Goal

Make every inference request **bounded, observable, and recoverable**:

1. No request ever runs past an explicit TTFT and total deadline; on breach the
   user gets a **typed, actionable error** quickly, not a generic late failure.
2. "Thinking" is never blind — a live **heartbeat** shows phase (prefill vs
   generating), elapsed, and tok/s, with a "taking long → cancel / smaller model
   / cloud" affordance after a soft threshold.
3. A stale/wedged local engine is **detected and recovered** (reload), not hung.
4. Cloud calls are **retry-bounded** and fail with provider-specific guidance.

This spec covers all three slices as one cohesive enforcement layer. Each slice
is independently shippable in this order: **1 → 2 → 3**.

---

## Shared foundation: a `PerfPolicy` + heartbeat contract

### `PerfPolicy` (the knobs — single source of truth)

A small policy object resolved per request, scaled by target (local vs cloud)
and overridable via settings + env. Defaults (calibration knobs — tune on real
hardware):

| field | local default | cloud default | env override |
|---|---|---|---|
| `ttftDeadlineMs` | 90_000 | 30_000 | `FERAL_TTFT_DEADLINE_MS` |
| `totalDeadlineMs` | 300_000 | 120_000 | `FERAL_TOTAL_DEADLINE_MS` |
| `stallMs` (idle between tokens) | 45_000 | 30_000 | `FERAL_STALL_MS` |
| `softWarnMs` (UI "taking long") | 20_000 | 15_000 | — (frontend) |
| `heartbeatMs` | 750 | 750 | — |

- **Frontend:** `frontend-react/src/lib/perfPolicy.ts` — `resolvePerfPolicy({ isCloud, promptTokens? })`. Read from the `settings` store (new optional fields) with the table above as fallback. Surfaced in Settings → a new "Performance" sub-section (out of scope for impl v1 — env + defaults are enough; leave the resolver settings-aware).
- **Sidecar:** `FeralAgent/src/sandbox/perf-policy.ts` — same shape, reads the `FERAL_*` env vars.
- **Rust:** read the same `FERAL_*` env vars in `inference.rs` (helper `perf_policy()` returning a `PerfPolicy` struct).

`ttftDeadlineMs` MAY scale with prompt size (large prompts legitimately prefill
longer): `effectiveTtft = base + promptTokens * perTokenPrefillMs` with
`perTokenPrefillMs` default 4 ms, capped at `totalDeadlineMs`. Keep this in the
resolver so all three layers agree.

### Heartbeat event (so "Thinking" is observable)

New event channel **`feral://stream-progress`** (mirror the existing
`events.rs` / `events.ts` pattern). Payload:

```ts
interface StreamProgressEvent {
  sessionId: string;
  phase: 'prefill' | 'generating';
  elapsedMs: number;
  promptTokens?: number;      // known after tokenization
  tokensGenerated?: number;   // generating phase
  tokensPerSec?: number;      // generating phase
}
```

- **Rust (`run_inference`)**: emit `phase:'prefill'` right after `on_start`
  (tokens counted) and on a ~`heartbeatMs` timer until the first sampled token;
  then `phase:'generating'` with running tok/s on the same cadence. Reuse the
  existing per-token loop; a cheap `Instant`-based throttle gates emission.
- **Sidecar (agent path)**: emit an equivalent `OutboundEvent` (`type:
  "stream_progress"`) on the same cadence from the streaming providers in
  `inference-providers.ts` (it already has the token callback + `resetIdle`).
- **Frontend**: `events.ts` adds `streamProgressEvent`; a new
  `stores/streamProgress.ts` (zustand) keyed by sessionId drives the UI.

### Typed deadline errors (actionable)

Deadline/stall aborts MUST be distinguishable from a user Stop and from a normal
error. Introduce a reason enum carried to the frontend via the existing
`feral://stream-error` payload (`error` string with a stable machine prefix):

| reason | message (humanizeError.ts) |
|---|---|
| `ttft_timeout` | "The model didn't start responding within {s}s. The prompt may be too long or the model too large for this hardware — try a shorter prompt, a smaller model, or a cloud key." |
| `total_timeout` | "Generation ran past the {s}s limit and was stopped. Try a smaller model or shorter output." |
| `stall_timeout` | "The model stopped producing output (no tokens for {s}s). It may have wedged — reloading is recommended." |
| `engine_unready` | "The local model isn't loaded or stopped responding. Reload it and try again." |

Extend `frontend-react/src/lib/humanizeError.ts` to map these prefixes to the
copy above + the relevant action (the file already maps inference errors to
fix-it actions; follow its pattern).

---

## Slice 1 — deadlines + progress + actionable failure

### Rust (`src-tauri/src/inference.rs`)
- In `generate`/`run_inference`, spawn a **watchdog** alongside the blocking
  generation: a Tokio timer task (or a second thread) that owns a shared
  `DeadlineState { reason: Mutex<Option<DeadlineReason>> }` and the existing
  `stop: Arc<AtomicBool>`. On TTFT/total breach it records the reason and sets
  `stop`, so the generation loop's existing cancel check (`inference.rs:1233`
  `break`) unwinds promptly.
- Distinguish *why* the loop stopped: when `stop` was set by the watchdog, emit
  `feral://stream-error` with the typed reason instead of `feral://stream-done`.
  When set by the user (existing `chat.stop()` path) keep current behavior.
- TTFT measured from `run_inference` entry to the first `tx.send`; total from
  entry to loop exit.
- Emit `feral://stream-progress` per the heartbeat contract.

### Sidecar (`FeralAgent/src/sandbox/inference-providers.ts`)
- Generalize `idleAbortController` into a `deadlineController(policy, signal)`
  that arms three timers: TTFT (cleared on first token), total (fixed), stall
  (reset per token via `resetIdle`). On any breach, abort with a tagged reason
  the router maps to a typed `InferenceError` (see `inference-router.ts`).
- Replace the hardcoded `300_000` / `CLOUD_IDLE_MS` at the call sites with
  `resolvePerfPolicy`. Keep `CLOUD_IDLE_MS` env back-compat.
- Emit `stream_progress` OutboundEvents on the token callback (throttled).

### Frontend
- `chatStream.ts`: add a **client-side watchdog** as a backstop — if NO event
  (token/progress/done/error) arrives within `totalDeadlineMs + grace`, surface
  a synthetic `engine_unready`/`total_timeout` error and clear the in-flight
  entry (covers a backend that emits nothing at all).
- `stores/streamProgress.ts`: consume `streamProgressEvent`; expose
  `{ phase, elapsedMs, tokensPerSec, promptTokens, soft }` (`soft` flips true
  past `softWarnMs`).
- UI: the existing "Thinking" indicator (assistant bubble / `MessageItem` or
  `ChatInput`) shows phase + elapsed + tok/s; past `softWarnMs` reveal a small
  row: **Cancel** (existing stop), **Use a smaller model** (→ ModelsPage),
  **Use cloud** (→ Settings → Cloud Keys). Reuse `StreamErrorNotice.tsx`
  patterns for the post-failure action.

---

## Slice 2 — health & staleness recovery

### Readiness preflight
- New Rust command `model_health() -> { loaded: bool, name?: string, responsive: bool }`
  in `inference.rs` (cheap: checks a model is loaded + the context pool has at
  least one idle/usable context without running a full decode).
- `useSendMessage` (chat) and the sidecar call it (sidecar: GET the loopback
  OpenAI `/health` or a tiny `/v1/models` on `localhost:11435`) **before**
  sending. If not loaded/responsive → surface `engine_unready` (with a Reload
  action) instead of sending into a hang.

### Wedged-engine recovery
- When a `stall_timeout`/`engine_unready` fires AND a follow-up `model_health`
  probe fails, mark the engine stale and **auto-reload** the model
  (`unload()` + reload the last `LoadedModel.path`, which the model store / Rust
  already track) before the user's retry; or expose a one-click "Reload model"
  in the error notice. Reload must never run concurrently with a live
  generation (respect the existing pool/Arc model-swap rules in `inference.rs`).

### Model TTL (jan-style, optional)
- Optional auto-unload of the loaded local model after `modelTtlMs` of
  inactivity (`FERAL_MODEL_TTL_MS`, default **0 = disabled**) to free RAM; the
  next request reloads it (with a `model-load-progress` surface already wired).
  Keep OFF by default — this is opt-in, since reload cost on weak disks is real.

## Slice 3 — cloud hardening

### Bounded retry + backoff (`inference-providers.ts` / `inference-router.ts`)
- On transient cloud failures (HTTP 429, 5xx, network reset) retry up to
  `maxRetries` (default 2) with jittered exponential backoff, **within
  `totalDeadlineMs`** — never beyond it. Non-transient (4xx auth/bad request)
  fail immediately.
- Emit a `stream_progress`-style "retrying (n/N)…" note so the UI shows activity
  rather than a freeze.

### Provider-specific errors + reasoning caps
- Map provider failures to typed errors in `humanizeError.ts`: 429 →
  "Provider rate-limited — retrying…/try later"; 401/403 → "API key invalid or
  out of credit — check Settings → Cloud Keys"; timeout → "Provider didn't
  respond within {s}s."
- Keep the existing `CLOUD_DEFAULT_MAX_TOKENS` reasoning cap (agent-loop.ts) and
  ensure cloud reasoning models can't exceed `totalDeadlineMs` regardless of
  token budget.

---

## Testing (each slice ships with runnable checks)

- **Sidecar (`bun test`):** `deadlineController` fires TTFT before first token,
  total at cap, stall on token silence, each with the correct tagged reason;
  retry/backoff retries on 429/5xx and gives up at `maxRetries` and at
  `totalDeadlineMs`; `resolvePerfPolicy` scales TTFT by prompt size and honors
  env. **No stubbed green tests** — assert real timer behavior with fake timers.
- **Rust (`cargo test`):** unit on the deadline-reason → error-string mapping
  and `perf_policy()` env parsing. The watchdog-sets-`stop` path tested at the
  smallest seam available (a fake generation that never yields a token must exit
  with `ttft_timeout` within the deadline).
- **Frontend (`vitest`):** `streamProgress` store transitions
  (prefill→generating→soft); `chatStream` client watchdog fires on total event
  silence; `humanizeError` maps each typed reason to the right copy + action.

## Guardrails (must NOT break)
- The user **Stop** path stays distinct from deadline aborts (different
  reasons, different UI) — `chatStream.ts` `requestStreamStop` and the Rust
  user-`stop` flow are unchanged in behavior.
- KV-cache prefix reuse and the model-swap/pool invariants in `inference.rs`
  are not disturbed by the watchdog or reload (reload only between generations).
- Connector profiles / agent-loop tool advertising (just shipped) untouched.
- Defaults are generous enough that a legitimately slow-but-working local model
  on weak hardware is NOT killed mid-prefill — TTFT scales with prompt size, and
  the heartbeat proves liveness so the watchdog only trips on real stalls.

## Out of scope (YAGNI)
- A full Settings UI for the perf knobs (env + scaled defaults suffice v1).
- Speculative decoding / engine swaps for speed — this spec is about *bounding
  and observing*, not making models faster.
- GPU offload tuning (separate effort).
