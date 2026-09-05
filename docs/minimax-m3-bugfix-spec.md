# Implementation spec — voice, cowork panel, and the run-row brick

**For:** MiniMax M3 (implementer). **Author:** Opus 5 audit, 2026-08-31.
**Repo:** `D:\Cinderpaw Agent`, base branch `main` at **`8e9b21c`** or later.

> **History, so the first attempt's confusion does not repeat.** This spec was
> written by reading `fix/arc-run-survives-errors`, but originally named `main`
> as the base — and `main` was 42 commits behind. A first implementation run
> branched from the old `main` and correctly reported that `warm_livekit` and
> `CallOverlay`'s `refreshS2s` "do not exist": on that tree they did not. They
> arrive in `25c9e88 fix(voice): pressing Call is a join now, not a
> fifteen-second boot`.
>
> **Resolved 2026-08-31:** `fix/arc-run-survives-errors` was fast-forwarded into
> `main`, which is now `8e9b21c`. `main` is the correct base again. Before you
> start, confirm you have it:
>
> ```
> git rev-parse --short main          # expect 8e9b21c or a descendant
> grep -c 'fn warm_livekit' src-tauri/src/commands/livekit.rs   # expect 1
> ```
>
> If either check fails, stop and report — do not work around it, and do not
> conclude the spec is wrong about the code until these two lines agree.

You are implementing this on your own. Nobody is going to fill in a gap for you
mid-task, so where a section says "verify first", verify first and report what
you found instead of guessing.

---

## 0. Where you work — you do not share this checkout

**Read this before your first `git` command.**

As of 2026-08-31 the checkout at `D:\Cinderpaw Agent` has had its branch moved
and holds uncommitted changes to `frontend-react/src/hooks/useLiveKitCallSession.ts`
and its test, made by whoever started on V1. If that is you: the work is fine,
the location is not.

**A git worktree is one checkout.** Two agents on two branches in the same
directory still overwrite each other's files, because `git switch` rewrites the
files on disk for everybody standing in that directory. A different branch is
not isolation. The author of this spec is working in `D:\Cinderpaw Agent` and
your checkouts collide there.

Get your own:

```
git worktree add ../cinderpaw-m3 -b fix/<task-branch> main
cd ../cinderpaw-m3
git rev-parse --short HEAD    # expect 8e9b21c or a descendant
```

That last line is not ceremony — see the note under the title. A stale `main` is
what made the first attempt at V3 conclude the code was missing.

One worktree per task branch, or one worktree you `git switch` between tasks —
either is fine, as long as it is not `D:\Cinderpaw Agent`.

**Carry your uncommitted work over rather than discarding it.** From
`D:\Cinderpaw Agent`, before you leave:

```
git diff -- <the paths you changed> > ../m3-wip.patch
git checkout -- <the paths you changed>
```

then `git apply ../m3-wip.patch` in your own worktree. Do not `git stash` in the
shared checkout — a stash there is one more thing for the next agent to trip
over.

Three standing rules for as long as `D:\Cinderpaw Agent` exists:

- **Never `git add -A` or `git add .`** — anywhere, in any worktree. Add named
  paths. A blanket add in a shared checkout stages files that belong to
  somebody else; it has already cost this repo a set of staged files once.
- **Do not `checkout`, `switch`, `reset` or `clean` in `D:\Cinderpaw Agent`.**
  If you need something from it, say so and stop.
- This document is `docs/minimax-m3-bugfix-spec.md`. `.gitignore:122` ignores
  `docs/2026-*.md`, which is why it carries no date in its name — **do not
  rename it back to a dated name**, it will silently stop being committable.

---

## 0.1 Ground rules (from `AGENTS.md` — these override your defaults)

- **Never work on `main`.** One branch per task, named in each task below.
- **One logical change per commit**, conventional commits.
- **Do not modify** `frontend-react/src/hooks/useCallSession.ts`, `vad.ts`, the
  Rust audio pipeline, or `mcp.json`. None of the tasks below need them.
  `useLiveKitCallSession.ts` is a *different* file and is in scope.
- **Keep diffs small.** If a task needs more than 3 files, stop and report.
- **Do not invent library APIs.** If unsure, stop and report.
- Before declaring a task done, run the checks named in that task. The full
  `./scripts/verify.sh` is the gate before the last commit of the batch.
- No refactoring outside the stated task. No drive-by improvements.

### The one product rule that decides ties

From the project's own `CLAUDE.md`: **every change ships for a stranger's
machine**, not for the developer's. A fresh install has no keys, no
`~/.cinderpaw`, no `node_modules`, a different OS and a different language.
Three failure shapes are named there, and two of the bugs below are exactly
those shapes:

- *Written for the repaired state* — a guard that only protects a value which
  already exists (**S1**, **V4**).
- *The message only I can read* — a reason that lands in stderr, not on the
  user's screen (**S1**).

If a fix cannot be made general, say so out loud rather than shipping the
narrow half quietly.

### Baseline (measured 2026-08-31, before any of this)

- `CinderpawAgent`: `bun test` — **3627 pass, 14 skip, 1 todo, 0 fail** (310 files, 153s).
- `frontend-react`: `tsc --noEmit` — **clean**.
- `frontend-react`: `vitest run --pool=threads --maxWorkers=1` — **73 files, 641
  pass, 0 fail**, *but with one unhandled error* — see **T1**.

Everything below is therefore an **untested gap, not a regression**. Each task
ships with the test that would have caught it.

---

## 1. Priority order

Do them in this order. T1 first, because until it is done the test suite can
report green for a file it never ran, and every acceptance check below is
measured with that suite. S1 second — it is the one that blocks the benchmark
work that comes next for this repo.

| # | Area | Severity | Branch |
|---|---|---|---|
| T1 | Test harness | **P0 — the green light can be a lie** | `fix/vitest-does-not-pass-a-file-it-never-ran` |
| S1 | Sidecar run store | **P0 — kills a session permanently** | `fix/run-row-does-not-brick-a-session` |
| V1 | LiveKit call hook | **P0 — Call button dies until app restart** | `fix/voice-call-button-survives-a-failed-start` |
| V2 | LiveKit call hook | P1 — call dies silently, mic stays hot | (same branch as V1) |
| V3 | Warmup | P1 — the warmup never applies after a settings change | `fix/voice-warmup-follows-the-settings` |
| V5 | Tauri typings | P3 — return type drift | (same branch as V3) |
| C1 | Cowork store | P1 — messages move to the wrong chat | `fix/cowork-exchange-keeps-its-thread` |
| C2 | Cowork store | P2 — cross-thread eviction + wrong order | (same branch as C1) |
| C3 | Cowork panel | P2 — teammate names collapse to raw ids | `fix/cowork-panel-names-filters-and-size` |
| C4 | Cowork panel | P3 — filter ignores approvals and typing rows | (same branch as C3) |
| C5 | Cowork panel | P3 — remembered height shrinks on every resize | (same branch as C3) |
| C6 | Cowork panel | P3 — pinned-id list grows forever | (same branch as C3) |
| V4 | LiveKit setup | P2 — **fresh-install only**: unpinned npm deps | `fix/voice-agent-deps-are-pinned` |
| B1 | Bench prep (§2) | P1 — a stack-wide score with no attribution | `feat/bench-subsystem-manifest` |
| B2 | Bench prep (§2) | P1 — research only, no code | (a document, no branch) |
| B3 | Bench prep (§2) | P2 — reproducibility kit | `docs/bench-reproducibility-kit` |

---

## T1 — The React suite reports green for a file it never ran

**Files:** `frontend-react/vitest.config.*` (locate it), `scripts/verify.sh`.

### Symptom, measured 2026-08-31

`bunx vitest run --pool=threads --maxWorkers=1` printed:

```
Test Files  73 passed (73)
     Tests  641 passed (641)
    Errors  1 error
[exited with code 0]
```

and above it:

```
Error: [vitest-pool]: Failed to start threads worker for test files
  .../src/hooks/__tests__/useCallSession.test.ts
Caused by: Error: [vitest-pool-runner]: Timeout waiting for worker to respond
```

`useCallSession.test.ts` **did not run**. It is not counted in the 73, it is not
reported as failed or skipped, and **the process still exited 0** — so
`scripts/verify.sh`, which is the project's stated gate before declaring
anything done, passes on a suite with a hole in it. The whole point of the gate
is that it cannot be green while something is untested, and right now it can.

Note which file this is: `useCallSession.ts` is one of the files `AGENTS.md`
forbids touching without an explicit instruction, i.e. exactly the code whose
test coverage nobody is watching by hand.

### What to do

Two things, in this order.

1. **Make an unrun file fail the run.** Vitest exposes this: set
   `dangerouslyIgnoreUnhandledErrors: false` (the default — confirm it has not
   been turned on) and add `bail`/`passWithNoTests: false` as appropriate, or
   fail on the `Errors: n` line explicitly. **Verify the exact option against
   the installed vitest version before using it — do not invent a config key.**
   If no config option makes the exit code non-zero, make `verify.sh` grep the
   output for `Unhandled Error` / `Failed to start` and fail on it. The
   requirement is the outcome, not the mechanism: *a run that could not execute
   a test file must not exit 0*.
2. **Then find out why that worker times out** and report it. Raising the
   worker timeout is an acceptable fix if that is genuinely all it is; a
   deadlock in the test's own setup is not, and needs to be said out loud
   rather than papered over with a longer timeout.

### Acceptance

- The suite still passes when everything runs.
- An artificially broken worker (or a stubbed error line) makes the command
  exit non-zero.
- `useCallSession.test.ts` actually runs and is counted — file count goes from
  73 to 74.

**Do this task first.** Every other task in this spec is verified by this
suite, and until it can fail, "the tests pass" is not evidence.

---

## S1 — A session can brick itself on an unclosed run row

**Files:** `CinderpawAgent/src/core/run-store.ts`, `CinderpawAgent/src/boot.ts`.

### Symptom

Every turn after some point in a session answers, verbatim:

> I wasn't able to answer that. Please try again.

Forever. The session never recovers. Observed in a tau2 airline trajectory on
2026-08-30 where the customer repeated the same request **eight times** and got
the identical dead sentence each time.

### Root cause

`run-store.ts:145`:

```ts
startRun(input: StartRunInput): RunRow | null {
  if (this.activeFor(input.sessionId)) return null;
```

`activeFor` is `SELECT * FROM runs WHERE session_id = ? AND status = 'running' LIMIT 1`.

There is **no staleness test, no owner, and no takeover**. Any row that reaches
`status = 'running'` and never gets `finish()`d — a turn that returned its text
while its run row stayed open, a crash mid-turn, an unattended continuation
that was never concluded — refuses every later turn in that session for the
lifetime of the database. `resumeInterruptedRuns` only covers rows found at
**boot**; it does nothing for a row that goes stale inside a live process.

Then `boot.ts:2032`:

```ts
if (!row) {
  log(`${surface}: ${sessionId} already has a run in flight — not starting a second`);
  return null;
}
```

The reason exists only in stderr. On a stranger's machine this is an agent that
broke for no reason, with nothing on screen saying why.

### What to do

Two halves. Ship both — the first alone leaves the silence, the second alone
leaves the brick.

**(a) A run row that nobody is driving is not a run in flight.**

In `RunStore.startRun`, before refusing: if the active row has not been touched
for longer than a staleness window, close it and proceed.

- The row already carries `updated_at` and `deadline_at`. Use them; do not add
  a column, and do not add a heartbeat thread.
- Treat the row as abandoned when **either** `deadline_at` is set and in the
  past, **or** `now - updated_at > CINDERPAW_RUN_STALE_MS` (default **10
  minutes** — long enough that a genuinely slow unattended turn is not stolen,
  short enough that a person is not locked out of their own conversation).
- Close it through the existing `finish(id, "unfinished", "not_continuable", …)`
  path so the row leaves `running` the same way every other abandoned run does.
  Do not `DELETE`.
- Log one line naming what was reclaimed and why.
- **Verify first:** confirm `updated_at` is actually written on every turn
  (`appendTurn`, or wherever the run row is touched). If it is only written at
  insert, the window degrades to "10 minutes after the run started", which is
  wrong for a long unattended run. If that is what you find, bump `updated_at`
  from `appendTurn` in the same change and say so in the commit body.

**(b) When it genuinely refuses, the person has to be told.**

`boot.ts` currently returns `null`, and the caller renders the generic "I wasn't
able to answer that." Return a real sentence instead — one a stranger can act
on, naming that an earlier task is still running in this conversation and what
they can do (wait, or start a new chat). One or two sentences, in the app's own
voice, through the same reply path the surface already uses. **Do not** put the
run id or the session id in the user-facing text.

### Acceptance

New test in `CinderpawAgent/tests/`, Bun, matching the style of the existing
run-store tests:

1. `startRun` for session `s`, not finished. A second `startRun` for `s`
   returns `null`. (Existing behaviour — keep it.)
2. Same, but backdate the first row's `updated_at` past the window: the second
   `startRun` **succeeds**, and the first row's status is `unfinished`.
3. A row whose `deadline_at` is in the past is reclaimed regardless of
   `updated_at`.
4. A row updated 30 seconds ago is **not** reclaimed.

Plus: `cd CinderpawAgent && bun test` stays at 0 fail.

### Not in scope

Do **not** try to fix *why* the row is left open in the first place. That is an
unverified hypothesis (see `CHECKPOINT_20260830_TAU2_RESULT_AND_ROADMAP.md` §2)
and this change makes the session survive it either way. Report anything you
notice; do not act on it here.

---

## V1 — A failed call start kills the Call button until the app restarts

**File:** `frontend-react/src/hooks/useLiveKitCallSession.ts`.

### Root cause

In `begin`:

```ts
const r = new Room();
room.current = r;          // <- assigned BEFORE the connect
…
await r.connect(call.url, call.token);
await r.localParticipant.setMicrophoneEnabled(true);
```

The `catch` sets a notice, sets `phase` back to `'ready'`, and calls
`endLivekitCall()` — but **never clears `room.current`** and never runs
`cleanup()`. The guard at the top of `begin` is:

```ts
if (starting.current || room.current) return;
```

So after any failed `connect` — a stale token, the server not up yet, the mic
refused after the room connected — `room.current` holds a dead `Room` and
**every subsequent press of Call returns immediately and does nothing**. No
error, no spinner, no second notice: the button is inert for the rest of the
process, and restarting the app is the only recovery.

Worse in the mic-refused case: if `connect` succeeded and
`setMicrophoneEnabled` threw, the room is connected with a live publication and
nothing holds a reference that could disconnect it.

### Fix

In the `catch` — and only there; the generation-mismatch early returns already
handle their own teardown — tear the attempted room down before reporting.
The smallest correct shape is to route the failure through the existing
`hangUp()` and then set the notice and `phase = 'ready'`: `hangUp` already does
the disconnect, the null, the `cleanup()` and the `endLivekitCall`, so a second
copy of that sequence in the catch is the thing that will drift. Mind the
ordering — `hangUp` clears `notice`, so set the notice **after** it.

### Acceptance

New test in `frontend-react/src/hooks/__tests__/`: mock `tauri.raw` and
`livekit-client` so `Room.prototype.connect` rejects once and then resolves.
Assert that after the first `begin()` fails, a second `begin()` actually calls
`startLivekitCall` again. Today it does not.

---

## V2 — The far end can die and the call keeps pretending

**File:** same as V1 — the `events.liveKitEvent.listen` effect.

### Root cause

`crates/cinderpaw-core/src/livekit_agent.mjs` emits two things the hook does not
fully use:

- `{ kind: 'closed' }` on `AgentSessionEventTypes.Close` — **the hook has no
  handler for it at all.**
- `{ kind: 'error', text, recoverable }` — the hook reads `text` and **drops
  `recoverable`**.

So when the agent session ends, or hits an error it cannot come back from, the
webview is still in the room, the microphone is still publishing, and the
overlay still says *listening*. The person keeps talking to nothing. On a
metered vendor key the mic stays open the whole time.

### Fix

- Handle `kind: 'closed'`: end the call the way the user pressing hang up does,
  and leave a notice saying the call ended — not an empty screen. The person
  needs to know it ended, rather than concluding they were not heard.
- On `kind: 'error'` with a falsy `recoverable`, do the same after setting the
  notice. When it is truthy, keep today's behaviour (notice only).
- Keep the Google-quota special case exactly as it is. It is a good message.

Ship on the V1 branch — same file, same failure family.

### Acceptance

Extend the V1 test file: emit a `closed` event and assert `endLivekitCall` was
called and `phase` is back to `'ready'`/`'idle'`; emit
`{ kind: 'error', recoverable: false }` and assert the same, plus the notice.

---

## V3 — The warmup never applies after the user changes anything

**Files:** `frontend-react/src/components/chat/CallOverlay.tsx`,
`src-tauri/src/commands/livekit.rs`, `frontend-react/src/lib/tauri/index.ts`.

Two independent halves of the same broken promise. Fix both or fix neither —
either one alone leaves the full wait on the button.

### Half one — the effect does not re-run on a voice change

`CallOverlay.tsx` around line 170:

```ts
useEffect(() => {
  if (phase === 'ready') { void refreshS2s(); warmLiveKit(); }
}, [phase, refreshS2s, s2sProvider, ttsProvider, sttProvider]);
```

The comment above it says *"Re-warmed on every change of vendor or voice"*. The
deps contain no voice. `warmLiveKit()` calls `callArgs()`, which reads
`ttsVoice[voiceKey]`, `whisperModel` and `language` from `useUI` — none of them
dependencies. Pick a different **voice** (or a different Whisper model, or
change the app language) on the pre-call screen and the effect never re-runs:
the chain stays warmed for the previous voice, `start_livekit_call` finds
`slot.spec != wanted`, tears it down, and the person pays the full ~14 second
boot on the button that was supposed to be instant.

**Fix:** add the missing values to the dependency array, read through the same
`useUI` selectors the rest of the component uses. Do **not** call
`useUI.getState()` inside the effect body to dodge the deps — that reproduces
the bug in a form the linter cannot see.

### Half two — `warm_livekit` refuses to replace a mismatched idle chain

`src-tauri/src/commands/livekit.rs`, in `warm_livekit`:

```rust
// Never touch a chain that already exists. It may be a live call.
if state.livekit_call.lock().is_some() {
    return Ok(());
}
```

Once **any** chain is parked, every later warmup is a no-op — including the
re-warm half one is supposed to trigger. `start_livekit_call` already makes this
decision correctly (it compares `session_spec` and drops a mismatch);
`warm_livekit` does not compare specs at all. So even with the deps fixed, the
re-warm does nothing and the boot stays on the button.

The comment names the real constraint: *it may be a live call*. That is the
missing information — the host cannot currently tell "warm and idle" from "a
person is on this call".

**Fix:**

1. Add an `IN_CALL: AtomicBool` beside the existing `GENERATION` / `WARMING`
   statics in `src-tauri/src/commands/livekit.rs`. Set it in
   `start_livekit_call` on both the rejoin and the cold path, after success;
   clear it in `end_livekit_call`. Do **not** move it into `AppState` — it
   belongs with the other two and there is no second consumer.
2. In `warm_livekit`, compute `session_spec` from the arguments exactly as
   `start_livekit_call` does, then:
   - `IN_CALL` set → return `Ok(())` (today's behaviour, now for the right
     reason);
   - a chain is parked and its `spec` **matches** → return `Ok(())`;
   - a chain is parked and the spec **differs** → drop it, then warm.
3. Keep the `WARMING` guard, the `find_node` / `find_server` bails, and the
   swallow-all-errors contract. A warmup must still never raise a dialog on
   somebody who has not asked for anything.

Mind the lock: a `parking_lot` guard must not be held across the `await` in
`start`. The existing code already models this — take the slot, drop the guard,
then await.

### V5, folded in here

`frontend-react/src/lib/tauri/index.ts:1003` types `startLivekitCall`'s result
as `{ url; token; room; mode }`. Rust's `LiveKitCall` also returns
`warm: boolean`. Add it. It is one word, and it is the only signal the UI has
for why a start took fourteen seconds this time and none the next.

### Acceptance

- Rust: cover the spec-comparison branch. If the surrounding code has no test
  harness for `AppState`, extract the decision into a small pure function —
  `fn warm_decision(in_call: bool, parked: Option<&str>, wanted: &str) -> Decision`
  — and test that. Do not build a mock host.
- React: extend `components/chat/__tests__/CallOverlay.test.tsx` — change the
  selected voice while `phase === 'ready'` and assert `warm_livekit` is invoked
  a second time.
- `cd frontend-react && bunx tsc --noEmit` clean.

---

## C1 — An exchange gets re-addressed to whatever chat you are reading

**File:** `frontend-react/src/stores/coworkTranscript.ts`, `applyCoworkEvent`.

### Root cause

```ts
const threadId = evt.threadId ?? fallbackThreadId ?? 'direct';
…
const prev = exchanges.find((e) => e.id === id);
const base: CoworkExchange = prev ?? { … };
…
case 'message_processed':
  next = { ...base, ...named, kind, threadId, responseText: …, status, at };
```

Every branch writes the **freshly computed** `threadId` over the one the
exchange already has, and `fallbackThreadId` is the *currently open*
conversation (`s.activeThreadId`).

So: a teammate turn starts in chat A and is filed under A. The person switches
to chat B while it runs — which is exactly what you do during a long turn. The
reply arrives as `message_processed` carrying no `threadId` of its own, the
fallback is now B, and **the whole exchange, request and reply, moves to chat
B**. It vanishes from chat A, where it belongs and where the mailbox recorded
it, and appears in a chat it has nothing to do with.

The existing test *"a thread-less teammate message is filed under the chat being
read"* covers the **first** sight of an exchange, which is right. Nothing covers
the second.

### Fix

An exchange's thread is decided once, when it is first seen:

```ts
const threadId = prev?.threadId ?? evt.threadId ?? fallbackThreadId ?? 'direct';
```

That is the whole change. Leave every branch otherwise alone.

### Acceptance

New test: ingest `message_received` (no `threadId`) with `activeThreadId =
'conv-1'`; `setThread('conv-2')`; ingest `message_processed` for the same
`messageId`, also with no `threadId`. Assert `threadExchanges(…, 'conv-1')` has
one exchange **carrying the response text**, and `threadExchanges(…, 'conv-2')`
is empty.

---

## C2 — One global cap, and rendering in update order

**File:** same as C1. Two defects, one fix each. Ship on the C1 branch.

**(a) The cap is global.** `COWORK_TRANSCRIPT_MAX = 100` is applied with
`.slice(-100)` over the **whole** list, which holds every thread's exchanges. A
busy conversation silently evicts a quiet conversation's history — and
`hydrate` runs the same slice after appending a thread's replayed mailbox rows,
so replaying one chat can drop another chat's transcript. `hydrate`'s own
comment already states the intended contract ("leave every other thread's
alone"); the cap is what breaks it. Cap **per thread**: keep the newest
`COWORK_TRANSCRIPT_MAX` for the thread being written and leave the other
threads' rows untouched.

**(b) The panel renders in update order, not chronological order.**
`applyCoworkEvent` returns `[...withoutPrev, next]`, so **every update moves its
exchange to the end of the array**, and `threadExchanges` only filters. A reply
landing on an older exchange drags that whole exchange to the bottom of the
transcript, below messages sent after it. In a group chat that reads as
messages spontaneously reordering themselves. Sort by `at` ascending inside
`threadExchanges`, with the exchange `id` as the tiebreak so the order is
stable — one place, and every caller already goes through it.

### Acceptance

- Two threads, 100 exchanges in one: assert the other thread's exchanges
  survive both `ingest` and `hydrate`.
- Three exchanges with `at` 1, 2, 3; update the first; assert
  `threadExchanges` still returns them in the order 1, 2, 3.

---

## C3–C6 — Cowork panel

**File:** `frontend-react/src/components/chat/CoworkTranscriptPanel.tsx`.
One branch, four small commits.

### C3 — teammate names collapse to raw ids

```ts
const participants = Array.from(new Map(exchanges.flatMap(e => [
  [e.fromAgentId, e.fromName], [e.toAgentId, e.toName],
]).filter(…)));
```

`new Map(entries)` keeps the **last** value for a duplicate key. The sidecar
sends `fromAgentName` / `agentName` only on some events, so one later exchange
with an absent name overwrites a known one with `undefined` — and the header,
the avatar tooltips, the filter chips and the composer's "Message …"
placeholder all fall back to the raw id. `displayName`'s own comment says nobody
should have to read `demo-agent-atlas`; this is how they end up doing so.

Fold instead of constructing a Map from entries, keeping the **first non-empty**
name per id.

### C4 — the filter only filters half the panel

`filteredMessages` applies `filterAgent` / `filterText` to messages, but
`approvals` and `working` are rendered unfiltered below them. Filter to one
teammate and you still see another teammate's approval row and typing row — and
when nothing matches, the "No messages match this filter" empty state is drawn
*underneath* rows that are plainly visible.

Apply `filterAgent` to both lists — an approval belongs to its `fromAgentId`, a
typing row to its `toAgentId`. Leave `filterText` on messages only; neither row
has body text to search.

### C5 — the remembered height shrinks a little every time

On mouseup the panel persists `inner.offsetHeight`. The scroll body carries
`style={{ height, maxHeight: '65vh' }}`, so on any window where 65vh is the
binding constraint, `offsetHeight` is **smaller** than the height in state — and
that smaller number is what gets stored and restored. Repeat, and the panel
creeps down toward `PANEL_MIN_H`.

Persist the state values (`width`, `height`) rather than measuring the clamped
DOM node.

### C6 — `cowork-pinned-ids` grows forever

Pins are keyed by `${exchangeId}:req|res` and written to `localStorage` on every
change, but an id is never removed when its exchange ages out of the transcript.
On a long-lived install this is an unbounded key. Prune on write: keep only ids
still present in the store's exchanges.

### Acceptance

Extend `components/chat/__tests__/CoworkTranscriptPanel.test.tsx`:

- C3: two exchanges for the same agent, the second with no name — assert the
  rendered header shows the name, not the id.
- C4: with `filterAgent` set, assert another agent's approval row is not
  rendered.
- C5: assert the persisted value equals the state value after a simulated
  resize (or unit-test whatever you extract).
- C6: a pure-function test on the prune.

---

## V4 — Fresh-install only: the voice agent's dependencies are unpinned

**File:** `crates/cinderpaw-core/src/livekit.rs`, `ensure_agent`.

### Root cause

```rust
let mut want: Vec<&str> = vec!["@livekit/agents", "@livekit/rtc-node"];
if let Some(p) = provider { want.push(p.plugin); }
let installed = |pkg: &str| pkg.split('/')
    .fold(root.join("node_modules"), |acc, seg| acc.join(seg)).exists();
if want.iter().all(|pkg| installed(pkg)) { return Ok(script); }
…
Command::new(npm).args(["install", "--no-audit", "--no-fund"]).args(&want)
```

Two fresh-install failures, and **neither can be seen on a machine that has
already made a call**. This is the "written for the repaired state" shape.

1. **No versions are pinned.** A machine that installs voice today gets
   whatever `@livekit/agents` npm publishes today, while the Rust that drives
   it — and `livekit_agent.mjs`, written from `include_str!` on every start —
   is pinned to this build. The day a breaking major lands, voice breaks for
   every **new** user and for nobody who already has `node_modules`. That is
   the hardest possible bug to see from a developer machine.
2. **"Installed" means the directory exists.** An interrupted install, a
   half-extracted package, a killed process — all leave a directory behind. The
   check then passes forever, and the failure surfaces inside the Node process
   as a module-not-found, which reaches the person as "the call did not start".

### Fix

- Put the exact versions in one `const` table next to `S2S_PROVIDERS` (vendor
  plugin versions included) and install `pkg@version`.
- Pick the versions currently resolved on this machine: read
  `~/.cinderpaw/livekit/agent/node_modules/<pkg>/package.json` and pin what is
  demonstrably working today. **Do not guess a version number.** If that
  directory does not exist on your machine, stop and report rather than
  inventing one.
- Make `installed` read that `package.json` and compare `version` against the
  pin. A missing or unreadable `package.json`, or a mismatch, means not
  installed — which repairs the interrupted-install case for free, since npm
  will then reinstall.
- Leave the error strings alone. They are already written for a person.

### Acceptance

`installed` becomes a pure function of a path plus an expected version. Unit
test it in `crates/cinderpaw-core` for: missing directory, directory with no
`package.json`, wrong version, right version. Do not test the npm invocation.

Run `cargo test -p cinderpaw-core`. **Do not run a bare `cargo check`** — it
fights the dev build's `target/` and can deadlock. If a dev build is running,
verify from the dev log instead.

---

## 2. Benchmark preparation (B1–B3)

These are not bug fixes. They are the work that has to exist **before** the next
benchmark runs, and none of it requires running a benchmark or spending a token
on a model. Do them after the P0/P1 fixes above.

### The two prohibitions, first

**Do not touch `db_match`, and do not try to raise the tau2 score.** The
2026-08-30 result was Cinderpaw 82.0% (41/50) against the reference agent's
86.0% (43/50) on the same harness, and the entire gap is `db_match` — passenger
ordering (tasks 8, 40), wrong `payment_id` (18), searched but never acted (15,
44), malformed arguments (32, 33). Those causes are **read from 50 known
trajectories**. Fixing them is fitting to a public test set, it is explicitly
forbidden, and it would make the number worthless. If you find yourself editing
agent behaviour because of a named task id, stop.

**Do not spend the OpenRouter balance.** There is roughly $10.96 on the key and
it is reserved for the final tau2 airline run, which the spec author runs. No
task in this document needs an inference call. If one seems to, you have
misread it — report instead of spending.

### B1 — A run must say which subsystems actually fired

**Severity:** P1 for the benchmark road. **Branch:** `feat/bench-subsystem-manifest`.

The next benchmark on the list (TheAgentCompany) is meant to run the whole stack
at once — BRSI, FMS, tool search, subagents, coworkers, the notebook. Two of
those are known to be capable of doing nothing at all while appearing enabled:
MCTS was **measured inert** on ARC-3, and cross-task memory does not engage
(semantic memory stays at 0 rows because nothing writes it and nothing reads it
unless the model chooses to call `recall`).

A score from "everything on" that cannot be attributed **has no cause when it
wins and no fix when it loses**. That is not a hypothetical; this repo has
already published a number for a mechanism that never ran, twice.

**Deliver:** one JSON manifest per benchmark run, written beside the run's
existing artifacts, recording for that run:

- BRSI: which L-layers emitted events, and how many.
- FMS: retrieval calls made, rows returned.
- Tool search: queries issued, hits returned, tools actually invoked as a result.
- Subagents spawned; coworker messages sent.
- `recall` invocations.
- Memory rows by kind (semantic / episodic), counted **before and after** the
  run, not just at the end — a total tells you nothing about whether this run
  wrote anything.
- MCTS invocations (expected: zero — record it anyway, so "inert" stays a
  measurement rather than a belief).

**Read the events that already exist on the bus.** Do not add new instrumentation
plumbing to subsystems; if a subsystem emits nothing today, record that fact in
the manifest as "no signal" rather than inventing an event for it, and report it.

**Acceptance — this is the whole test.** Run the same task twice, once with a
subsystem deliberately disabled and once with it enabled. The manifest must show
zero for the disabled run and non-zero for the enabled one. A manifest that
cannot tell those two runs apart is decoration, and shipping it would be worse
than shipping nothing: it would look like attribution.

### B2 — Find out what TheAgentCompany's scorer actually reads

**Severity:** P1. **Branch:** none — this produces a document, not code.
**Write no bridge code.**

tau2 cost this project an entire design iteration on exactly this question. Its
scorer grades a **replay of the recorded trajectory**, not the live environment:
a tool call made outside that trajectory scores zero. A bridge designed on the
opposite assumption was built and thrown away.

**The question:** does TAC's scorer read **environment state at checkpoints**, or
a **replayed transcript** of the agent's tool calls?

It decides the whole shape of the integration. If it grades environment state,
then the benchmark is a connector into the runtime and no tool-call routing is
needed. If it grades a replay, it is not, and everything the agent does off the
recorded path is invisible to the grade.

**Deliver:** a short document in `docs/` (undated name — see §0) answering that
question, with **file and line citations into the TAC repository for every
claim**. Rules:

- Cite the scorer's own source. The README is not evidence of what the scorer
  reads.
- If you cannot locate the scoring code, say so and stop. "I could not find it"
  is a useful finding; a confident inference is the failure mode this task
  exists to prevent.
- Note anything where TAC's rules and our harness would disagree, the way the
  ARC work found three such places. Do not fix them here.

### B3 — Make the reproducibility finding re-runnable by a stranger

**Severity:** P2. **Branch:** `docs/bench-reproducibility-kit`.

The strongest result from 2026-08-30 is not 82%. It is this: the **official**
tau2 `llm_agent`, unmodified, running `z-ai/glm-5.3-flash`, scores **86.0% on
this harness against 77.3% published** on OpenRouter's board. Same agent, same
model, 8.7 points, differing only in harness. That is a claim anyone can
re-run, and it does not require Cinderpaw to win anything.

It is only worth something if a stranger can reproduce it. **Deliver:** one
command, plus a README stating exactly what is and is not claimed, pinning:

- the tau2-bench version/commit,
- the agent (`llm_agent`, unmodified — say so),
- the model id `z-ai/glm-5.3-flash` and the user-simulator model
  `gemini-2.5-flash`,
- `--max-steps 200`, the task set (airline, 50 tasks), and the seed if there is
  one,
- what it costs to run, measured, so the reader knows what they are committing to.

**Hard constraint:** the comparison **82% vs 77.3% is invalid and must never
appear** in this kit or anywhere else — those are different harnesses. Only
same-harness numbers may be compared in the same sentence. If a sentence you
write puts a Cinderpaw number next to a published leaderboard number, delete it.

State plainly what the 82% does not cover: each task ran with a fresh
`CINDERPAW_HOME`, so no MCP extensions, no skills, no soul, no cross-task
memory, no settings, brain disabled, built-ins behind the drawer. The honest
phrasing is **"Cinderpaw's agent loop"**, never "Cinderpaw".

---

## 3. Definition of done for the whole batch

1. Each branch's own checks pass, as named in its task.
2. `./scripts/verify.sh` is green end to end before the final commit.
3. Every task ships the test named in its Acceptance section. A fix without its
   test is not done.
4. Report back, per task: what you changed, what the test asserts, and anything
   that contradicts this spec. **This spec was written by reading the code, not
   by running the app.** If the code disagrees with a claim here, the code is
   right and the claim is a bug in this document — say so rather than bending
   the code to match.

## 4. Deliberately NOT in scope

- Why a run row is left open in the first place (S1's cause). Survive it; do
  not chase it.
- Any change to `useCallSession.ts`, `vad.ts`, the Rust audio pipeline, or
  `mcp.json`.
- Bundling the LiveKit agent's `node_modules` into the installer. That is the
  right long-term answer to V4 and it is separate work; V4 pins what ships
  today.
- The cross-task memory gap (semantic memory stays at 0 rows). Known, measured,
  and a design question rather than a bug fix.
