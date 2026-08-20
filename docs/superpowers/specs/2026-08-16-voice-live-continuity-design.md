# Speech-to-Speech Live Continuity — Design Spec

**Date:** 2026-08-16  
**Status:** Proposed; awaiting spec review  
**Scope:** Gemini Live speech-to-speech calls. Pipeline calls receive a smoke test
only; `frontend-react/src/hooks/useCallSession.ts` and `frontend-react/src/lib/vad.ts`
remain untouched.

## Summary

Close the remaining voice-mode chapter by making a Live call behave like one
continuous, truthful conversation: the user's received speech appears without
turn-over-turn delay, long text cannot overwhelm the sphere, real work is visible,
and dead or missing streams are reported honestly.

The work is evidence-driven. Existing Rust ingress tracing and new frontend render
markers establish where transcript latency occurs before production behavior is
changed. Rust transcript-path code is modified only if those measurements locate
the delay there. Tool correlation is a separate protocol correction justified by
an already-observed structural gap: the raw sidecar event bus is global and its
wrapper carries no session identifier.

## Locked decisions

- **Primary target:** Speech-to-speech Live. Pipeline is not assumed broken and
  its protected controller is not modified.
- **No invented transcript:** the UI shows only text received from Gemini Live.
- **Complete history:** interim transcript pieces are display state only. Exactly
  one user message is committed at `turnComplete`, equal to the ordered
  concatenation of that turn's received input pieces.
- **Compact call surface:** the sphere shows the most recent complete words,
  prefixed with an ellipsis when truncated, within three rendered lines. The full
  message remains in normal chat history.
- **Event-backed activity:** prose such as “I will search” never creates a widget.
  Activity begins, progresses, and ends only from lifecycle events correlated to
  the current Live request.
- **Honest dead-flow state:** delayed or absent transcript events show listening
  or transcribing state, never fabricated captions. A closed socket shows a
  disconnected state and cannot continue to claim it is listening.
- **No accumulation:** call teardown restores listener, timer, and
  application-owned retained-object counts to their pre-call values.
- **Change budget:** each implementation commit touches at most three files. No
  unrelated refactor is part of this work.

## Current architecture and evidence

### Transcript path

The path is:

`Gemini Live → crates/feral-core live session → src-tauri live pump →`
`feral://live-status → useLiveCallSession → CallOverlay`

Rust already logs each input transcript piece and a per-turn cadence summary.
`useLiveCallSession` already accumulates pieces in `heardRef`, renders `heard`, and
commits one chat message at `turnComplete`. The remaining uncommitted diagnostic
code records frontend piece gaps. No root-cause claim is made from those gaps
alone.

### Tool path

Gemini calls the Rust-visible `ask_feral` function. Rust forwards the request to
the sidecar with a generated message id. Sidecar `tool_start`, `tool_progress`, and
`tool_done` events contain the message id or its `traceId`, but
`feral://agent-output` is a global bus whose Tauri wrapper contains only opaque
JSON. `useLiveToolActivity` currently accepts every tool event observed while a
call overlay is open. A cron or connector tool run can therefore be rendered as
if the call started it. This is the cross-surface correlation defect addressed by
Slice 3.

## Slice 1 — Quantified transcript latency and turn integrity

### Measurement contract

For each received input piece, define:

- `R(t,p)`: the wall-clock timestamp in the existing Rust ingress trace for turn
  `t`, piece `p`;
- `U(t,p)`: the wall-clock timestamp recorded by a `useLayoutEffect` after the
  `CallOverlay` DOM commit whose accumulated transcript first includes piece
  `(t,p)`;
- `L(t,p) = U(t,p) - R(t,p)`: Rust-ingress-to-render-commit latency.

Pieces are matched by ordered turn number and cumulative transcript length. The
frontend marker includes turn number, cumulative character count, and timestamp;
the Rust trace already preserves ingress order. This avoids changing the
production Live event schema merely to diagnose it.

Each of the ten real test turns must contain at least 20 transcript pieces; a
shorter turn is repeated and is not used for percentile comparisons. Let `B` be
the p95 of `L(1,p)` after the first piece, which is discarded as call warm-up.

The run passes only when all of the following hold:

1. p95 of `L(t,p)` across turns 2–10 is at most `B + 50 ms`.
2. `p95(L(10,p)) - p95(L(1,p))` is at most `50 ms`.
3. No turn has a growing undrained transcript queue at completion.
4. Listener and timer counts after hang-up equal their counts before the call.

The two latency assertions are separate deliberately: the first bounds normal
dispatch/render overhead relative to a measured baseline, while the second
detects the accumulation symptom even on a uniformly slow machine.

If Rust ingress is already late, the next investigation stays on the vendor/live
session side. If Rust ingress is timely but `U` is late, the fix stays in the
Tauri/frontend path. Only the boundary named by the measurements is changed.

### Golden turn-history contract

The deterministic hook test emits input pieces such as `['Ana ', 'are ',
'mere']`, verifies that no chat message is created after any interim piece, then
emits `turnComplete`. The resulting history must contain exactly one new user
message whose content is `Ana are mere`. A second turn proves that no piece from
the first turn carries over.

Output transcript pieces follow the same rule for the assistant message. A turn
containing only input or only output commits only the non-empty side. A socket
close never commits an unfinished fabricated message.

### Dead-flow state machine

The visible states are derived from connection and observed data:

- socket connected, microphone active, no voiced frame pending: **Listening**;
- voiced microphone data sent, but no corresponding input transcript received:
  **Transcribing**;
- transcript received: display the received text while the call remains live;
- socket closed or start failed: **Disconnected**, with the bounded backend
  reason when one exists.

The transcribing state is cleared by the first input transcript piece,
`turnComplete`, hang-up, or socket close. Socket close wins over every other
state, so the UI can never show Listening or Transcribing for a dead connection.
No timeout manufactures words or promotes an interim buffer into history.

### Files and commit boundaries

The diagnostic/golden commit is limited to:

- `frontend-react/src/hooks/useLiveCallSession.ts`
- `frontend-react/src/hooks/__tests__/useLiveCallSession.test.ts` (new)
- `frontend-react/src/components/chat/CallOverlay.tsx`

If measurements locate the defect in Rust, the Rust fix is a later, isolated
commit touching only the measured failing unit and its colocated test. It is not
pre-authorized as a speculative rewrite.

## Slice 2 — Compact, correct transcript presentation

### Display contract

The overlay receives the complete accumulated `heard` string, but its compact
presentation is produced by a pure helper with a 280-character budget:

1. If the normalized text fits, return it unchanged.
2. Otherwise retain the newest sequence of complete whitespace-delimited words
   that fits beside the prefix `… `.
3. Never cut a word. If a single token is longer than the available budget,
   render only `…` rather than a misleading fragment.
4. CSS clamps the result to three lines and keeps the call-stage geometry fixed.
5. The unabridged value is exposed as the accessible label and is committed to
   history only through the Slice 1 final-turn contract.

The golden boundary test uses a five-line input whose cut point falls inside a
word under naive character slicing. It asserts the exact ellipsized suffix, the
absence of the partial word, and an output length no greater than 280 characters.
Inputs of 1,000 and 10,000 characters must not expand the transcript container
beyond its three-line bound.

### Files and commit boundary

- `frontend-react/src/components/chat/CallOverlay.tsx`
- `frontend-react/src/components/chat/__tests__/CallOverlay.test.tsx` (new)
- `frontend-react/src/components/chat/ChatInput.tsx` only if the approved
  Listening/Transcribing state needs an explicit prop; it is not used for layout
  refactoring.

The existing `voice.transcribing` translation is reused. No i18n file change is
needed.

## Slice 3 — Session-correlated tool activity

### Correlation contract

The generated sidecar message id becomes the Live request `traceId`:

1. `live.rs` creates the id before dispatch and emits the outer `toolCall` status
   with the request text and `traceId`.
2. `bridge.rs` sends that same id as the sidecar message id instead of generating
   a hidden second id.
3. Sidecar tool events already carry the message id/`traceId`; no sidecar API is
   changed.
4. `useLiveToolActivity` keeps the active trace ids for the current Live session
   and accepts raw `tool_start`, `tool_progress`, and `tool_done` only when their
   trace id is active.
5. `toolResult`, hang-up, or socket close retires the active id and its listeners.

An event without a matching active Live trace is ignored by the call widget. It
may still be consumed normally by its originating cron, connector, or text-chat
surface.

The negative test starts a Live call, emits a cron/connector `tool_start` with a
different trace id, and asserts that the call activity array and widget remain
empty. It then emits an identically shaped event with the active Live trace id
and asserts that the widget starts. Completion and failure are tested with the
same correlation requirement.

### Files and commit boundaries

Protocol propagation is one three-file commit:

- `crates/feral-core/src/live/bridge.rs`
- `src-tauri/src/commands/live.rs`
- `src-tauri/src/events.rs`

Frontend consumption is a second three-file commit:

- `frontend-react/src/lib/tauri/events.ts`
- `frontend-react/src/hooks/useLiveToolActivity.ts`
- `frontend-react/src/hooks/__tests__/useLiveToolActivity.test.ts`

The `LiveStatusEvent` extension is optional/backward-compatible while the two
commits are between revisions: absent `traceId` means the raw event is not trusted
as call-owned and no inner widget is shown. The outer `ask_feral` activity remains
visible from its session-scoped Live status.

## Soak and leak verdict

The accelerated soak advances fake time through the equivalent of three hours
and thousands of transcript, tool, completion, interruption, and close events.
It repeatedly opens and hangs up calls rather than exercising only one immortal
hook instance.

The test records a baseline before the first open and compares it after the final
hang-up. It passes only with:

- listener count difference: `0`;
- active timer count difference: `0`;
- active Live trace-id count: `0`;
- retained transcript/tool rows owned by the call modules: `0`;
- pending microphone queue length: `0`.

Raw total JavaScript heap bytes are not required to be bit-identical: WebView,
JIT, allocator, and test-runner caches make that value nondeterministic. The
heap assertion instead takes post-GC snapshots and filters retained objects to
the call modules above; their retained-object-count difference must be exactly
zero. Overall heap size and slope are reported as diagnostics, not used to turn a
healthy zero-retention run into a flaky failure.

The real acceptance run is one Live call of at least 20 turns. It repeats the
latency measurements, exercises one real tool success and one real tool failure,
uses a long typed prompt, interrupts one reply, and verifies the final chat
history. The user is asked for microphone/key participation only when this run
is ready to start.

## Error handling

- Missing or delayed input pieces: show Listening/Transcribing state; never add
  guessed text.
- Closed socket: stop microphone/playback, clear transient activity, show
  Disconnected plus the bounded close reason.
- Tool start without completion: remain visibly running with elapsed time until
  a real result, hang-up, or socket close; never synthesize success.
- Tool completion without a matching active trace: ignore it in voice UI.
- Malformed raw sidecar JSON: ignore it without throwing inside the listener.
- Measurement/logging failure: fail the diagnostic run as inconclusive; do not
  reinterpret missing measurements as a pass.

## Verification gates

Each slice follows red-green-refactor discipline and runs its targeted Vitest or
Rust test before the next slice. Final verification requires:

1. targeted Live hook, overlay, and tool-activity tests;
2. `cd frontend-react && bunx tsc --noEmit`;
3. accelerated three-hour-equivalent soak with the explicit zero-difference
   verdict above;
4. the real 20-turn Live acceptance run;
5. `./scripts/verify.sh` fully green.

## Out of scope

- Changes to pipeline turn-taking, VAD, or the Rust audio pipeline without a
  separate explicitly named task.
- A parallel local STT stream solely to manufacture earlier captions when the
  vendor withholds transcription.
- Unifying Live and Pipeline under one controller.
- Visual redesign of the sphere, controls, or tool widgets beyond transcript
  bounds and honest state labels.
- New tools or changes to tool execution semantics.
