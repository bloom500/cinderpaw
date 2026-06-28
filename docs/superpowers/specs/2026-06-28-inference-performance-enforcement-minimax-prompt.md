# MiniMax M3 — implementation prompt: inference performance enforcement

Paste everything below the line into MiniMax M3. It is self-contained.

---

You are implementing a feature in the **Feral** desktop app (Tauri + React
frontend, Rust `src-tauri`, and a Bun/TypeScript sidecar in `FeralAgent/`).
Repo root: `D:\FeralLocalAI`. Branch: `feat/reactive-pixel-tree`.

**Read the design spec first and follow it exactly:**
`docs/superpowers/specs/2026-06-28-inference-performance-enforcement-design.md`

## Your job

Implement **Slice 1 first** (deadlines + heartbeat progress + actionable
errors), then Slice 2 (health/staleness recovery), then Slice 3 (cloud
hardening) — as described in the spec. Ship each slice with its runnable tests
before moving to the next.

## Non-negotiable guardrails

1. **Verify every artifact is real before you touch it.** The spec names exact
   files/functions/events — `grep` them and read the surrounding code before
   editing. Do NOT invent files, functions, events, or config fields. If
   something in the spec doesn't match the code, STOP and report the mismatch
   instead of inventing a workaround. Key anchors to confirm by reading:
   - `src-tauri/src/inference.rs`: `stream_chat` (~:273), `generate` (~:987),
     `run_inference` (~:1047), the `on_start` callback, the per-token
     `tx.send(...)`, and the `stop: Arc<AtomicBool>` + its loop check (~:1233).
   - `FeralAgent/src/sandbox/inference-providers.ts`: `idleAbortController`
     (~:824), `CLOUD_IDLE_MS`, `resetIdle`, the loopback `300_000` call sites.
   - `FeralAgent/src/sandbox/inference-router.ts`: `InferenceError`, `complete`.
   - `frontend-react/src/lib/chatStream.ts` (no client watchdog today),
     `frontend-react/src/lib/tauri/events.ts` (the `feral://...` channels +
     payload interfaces), `frontend-react/src/lib/humanizeError.ts`,
     `frontend-react/src/components/chat/StreamErrorNotice.tsx`.
   - Event names already in use: `feral://token`, `feral://stream-done`,
     `feral://stream-error`, `feral://stream-start`, `feral://stream-usage`,
     `feral://stream-truncated`, `model-load-progress`. Add `feral://stream-progress`
     following the SAME registration pattern (Rust `events.rs` struct + emit,
     `events.ts` `wrap<StreamProgressEvent>('feral://stream-progress')`).

2. **No green-stub tests.** Tests must assert REAL behavior, not a stub that
   always passes. For timers use fake/虚 timers and assert the deadline actually
   fires with the correct tagged reason. A test that would still pass if the
   feature were deleted is unacceptable.

3. **Do not break these (the spec's guardrails):**
   - The user **Stop** path stays behaviorally identical and DISTINCT from
     deadline aborts (different reason, different UI). `chatStream.ts`
     `requestStreamStop` and the Rust user-`stop` flow keep working as-is.
   - KV-cache prefix reuse and the model-swap/pool invariants in `inference.rs`
     — the watchdog only sets the existing `stop` flag; reload happens only
     BETWEEN generations, never during one.
   - The agent tool-drawer / connector profiles (recently shipped) — untouched.
   - Defaults must NOT kill a slow-but-working local model mid-prefill: TTFT
     scales with prompt size and the heartbeat proves liveness, so the watchdog
     trips only on real stalls. Verify with a deliberately slow path.

4. **Sidecar build step (critical).** The `FeralAgent` TS sidecar is compiled to
   an exe. After any TS change run, from `FeralAgent/`:
   `bun run build` then copy `dist/feral-agent.exe` →
   `src-tauri/binaries/feral-agent-x86_64-pc-windows-msvc.exe`.
   TS edits are NOT live until you do this. Confirm the file timestamp updated.

5. **Confirm your files actually wrote to disk.** After each file create/edit,
   `ls`/read it back. Do not report a file as written without verifying it
   exists on disk.

## Verification (run and paste real output for each slice)

- Sidecar: `cd FeralAgent && bun run typecheck && bun test tests/<your-new>.test.ts`
- Frontend: `cd frontend-react && npx tsc --noEmit && npx vitest run <your-new>`
- Rust: `cd src-tauri && cargo test <your-new module>` (build may be slow — that's fine).
- Do NOT claim a slice is done until its tests pass with output shown.

## Scope boundary (what Opus integrates, not you)

Implement the **leaf units** with the fixed contracts from the spec:
`perfPolicy.ts` / `perf-policy.ts` / Rust `perf_policy()`, the
`deadlineController`, the Rust watchdog + `stream-progress` emit, the
`streamProgress` store, the `humanizeError` reason mappings, the
`model_health` command + preflight, the retry/backoff util. Keep each unit
small, single-purpose, and independently testable. Wire them into the existing
call sites exactly where the spec says — but if a wiring decision is ambiguous
or would touch the streaming-state machine in a way the spec doesn't pin down,
STOP and ask rather than guessing.

When a slice is complete: report the files changed, the test output, and any
spec mismatches you hit. Do not start the next slice until the current one's
tests are green.
