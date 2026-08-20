# Speech-to-Speech Live Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Gemini Live calls responsive, compact, truthfully stateful, and correlated to their own real tool execution without changing Pipeline/VAD behavior.

**Architecture:** Preserve the separate Live controller. Measure Rust ingress to React commit before choosing a latency fix, keep interim transcript pieces out of history until `turnComplete`, derive labels from observed connection/audio state, and propagate the sidecar message id as a Live `traceId` so global tool events can be filtered to their owning call.

**Tech Stack:** React 18, TypeScript 7, Vitest 4, Zustand, Tauri 2 events, Rust/Tokio, Bun.

**Spec:** `docs/superpowers/specs/2026-08-16-voice-live-continuity-design.md`

## Global Constraints

- Work only on `voice-mode`; never on `main`.
- Do not modify `useCallSession.ts`, `vad.ts`, the Rust audio pipeline, or `mcp.json`.
- Each commit touches at most three files and preserves unrelated dirty changes.
- Never fabricate transcript or tool state.
- Change Rust transcript behavior only if the 10-turn measurement locates the delay there.
- Final history equals the ordered completed-turn pieces, with no interim messages.
- Final gate: `./scripts/verify.sh` and the real 20-turn Live acceptance run.

---

### Task 1: Pin Live transcript integrity, teardown, and measurement

**Files:**
- Create: `frontend-react/src/hooks/__tests__/useLiveCallSession.test.ts`
- Modify: `frontend-react/src/hooks/useLiveCallSession.ts`
- Modify: `frontend-react/src/lib/i18n.ts`

**Interfaces:**
- Consumes: `events.liveStatusEvent`, `captureMicPcm`, `useChat`, existing `CallPhase`.
- Produces: existing return shape plus `transcribing: boolean`; dev-only render markers `turn`, `piece`, `chars`, `renderedAt` through `tauri.raw.uiLog`.

- [ ] **Step 1: Create a deterministic event harness**

Use hoisted listener/capture mocks and the real chat store:

```ts
type LiveEvent = { payload: { sessionId: string; kind: string; text: string } };
const liveListeners = vi.hoisted(() => new Set<(event: LiveEvent) => void>());
const unlisten = vi.hoisted(() => vi.fn());
const capture = vi.hoisted(() => ({
  callback: null as null | ((frame: Float32Array, loudness: number) => void),
  stop: vi.fn(),
}));

vi.mock('@/lib/tauri/events', () => ({
  events: { liveStatusEvent: { listen: vi.fn(async (callback: (event: LiveEvent) => void) => {
    liveListeners.add(callback);
    return () => { liveListeners.delete(callback); unlisten(); };
  }) } },
}));

function emit(kind: string, text = '', sessionId = 'voice-session') {
  act(() => {
    for (const callback of liveListeners) callback({ payload: { sessionId, kind, text } });
  });
}
```

Mock `tauri.raw` with `startLiveCall`, `endLiveCall`, `sendLiveAudio`, `sendLiveText`, `getLastTask`, and `uiLog`; mock `captureMicPcm` so the callback is stored in `capture.callback`; mock `useSpeechPlayer` with stable `beginSpeech` and `stop` functions.

- [ ] **Step 2: Write the golden-history test**

```ts
it('commits one exact final pair and never stores interim fragments', () => {
  renderHook(() => useLiveCallSession());
  emit('inputTranscript', 'Ana ');
  expect(useChat.getState().messages).toHaveLength(0);
  emit('inputTranscript', 'are ');
  expect(useChat.getState().messages).toHaveLength(0);
  emit('inputTranscript', 'mere');
  emit('outputTranscript', 'Da, are.');
  expect(useChat.getState().messages).toHaveLength(0);
  emit('turnComplete');
  expect(useChat.getState().messages.map(({ role, content }) => ({ role, content }))).toEqual([
    { role: 'user', content: 'Ana are mere' },
    { role: 'assistant', content: 'Da, are.' },
  ]);
  emit('inputTranscript', 'A doua întrebare');
  emit('turnComplete');
  expect(useChat.getState().messages.at(-1)?.content).toBe('A doua întrebare');
});
```

Add cases for input-only, output-only, mismatched session id, and socket close before `turnComplete`.

- [ ] **Step 3: Write dead-flow and teardown tests**

```ts
it('never reports listening on a dead socket', async () => {
  const { result } = renderHook(() => useLiveCallSession());
  await act(async () => { result.current.open(); await result.current.begin(); });
  act(() => capture.callback?.(new Float32Array([0.2]), 0.04));
  expect(result.current.transcribing).toBe(true);
  emit('closed');
  expect(result.current.phase).toBe('ready');
  expect(result.current.transcribing).toBe(false);
  expect(result.current.notice).toBeTruthy();
});

it('restores timers and listeners to baseline', () => {
  vi.useFakeTimers();
  const listenersBefore = liveListeners.size;
  const timersBefore = vi.getTimerCount();
  const { result, unmount } = renderHook(() => useLiveCallSession());
  emit('inputTranscript', 'turn');
  emit('turnComplete');
  act(() => result.current.hangUp());
  expect(vi.getTimerCount()).toBe(timersBefore);
  unmount();
  expect(liveListeners.size).toBe(listenersBefore);
  expect(unlisten).toHaveBeenCalledOnce();
});
```

- [ ] **Step 4: Run the new tests and observe failure**

```bash
cd frontend-react && bunx vitest run src/hooks/__tests__/useLiveCallSession.test.ts
```

Expected: `transcribing` is absent and the untracked linger timeout survives teardown.

- [ ] **Step 5: Implement one transient reset path**

Import `useLayoutEffect` and the existing `SPEECH_RMS` constant without modifying `vad.ts`. Add:

```ts
const TRANSCRIPT_WAIT_MS = 250;
const [transcribing, setTranscribing] = useState(false);
const heardTimerRef = useRef<number | null>(null);
const lastTranscriptAtRef = useRef(0);
const pieceRef = useRef(0);

const clearHeardTimer = useCallback(() => {
  if (heardTimerRef.current !== null) window.clearTimeout(heardTimerRef.current);
  heardTimerRef.current = null;
}, []);

const resetTransient = useCallback(() => {
  clearHeardTimer();
  micQueue.current = [];
  micBusy.current = false;
  heardRef.current = '';
  saidRef.current = '';
  freshRef.current = true;
  lastTranscriptAtRef.current = 0;
  pieceRef.current = 0;
  setTranscribing(false);
  setHeard('');
  setLevel(0);
}, [clearHeardTimer]);
```

Use it in `open`, before `begin`, `hangUp`, `closed`, and unmount. Track the linger timeout in `heardTimerRef`. In the mic callback set `transcribing` only when `loudness >= SPEECH_RMS` and no transcript arrived for `TRANSCRIPT_WAIT_MS`; clear it on input piece, interruption, turn completion, close, and hang-up.

- [ ] **Step 6: Add render-commit markers**

Increment `pieceRef` per input piece. Add:

```ts
useLayoutEffect(() => {
  if (!import.meta.env.DEV || !heard || pieceRef.current === 0) return;
  void tauri.raw.uiLog(
    'live-render',
    `turn=${turnsRef.current + 1} piece=${pieceRef.current} chars=${heard.length} renderedAt=${Date.now()}`,
  ).catch(() => {});
}, [heard]);
```

Reset `pieceRef` at `turnComplete`; preserve the existing per-turn worst-gap diagnostic.

- [ ] **Step 7: Make the disconnected fallback explicit**

Change only the two existing values:

```ts
'call.liveClosed': 'Disconnected. Press call to reconnect.',
'call.liveClosed': 'Deconectat. Apasă pe apel ca să reconectezi.',
```

- [ ] **Step 8: Verify and commit**

```bash
cd frontend-react && bunx vitest run src/hooks/__tests__/useLiveCallSession.test.ts
cd frontend-react && bunx tsc --noEmit
git add frontend-react/src/hooks/useLiveCallSession.ts frontend-react/src/hooks/__tests__/useLiveCallSession.test.ts frontend-react/src/lib/i18n.ts
git commit -m "test(voice): pin live transcript continuity"
```

---

### Task 2: Measure ten real turns before a latency fix

**Files:**
- Read only: runtime logs.
- Conditional modify: only the measured failing unit and its test, maximum three files.

**Interfaces:**
- Consumes: Rust `live: input transcript piece`, frontend `live-render`, per-turn cadence.
- Produces: `B`, p95 turns 2–10, p95 turn 1, p95 turn 10, listener/timer deltas.

- [ ] **Step 1: Start the dev app and request microphone/key participation**

Use the existing Tauri dev command. The user performs ten turns with at least 20 transcript pieces each; shorter turns are repeated.

- [ ] **Step 2: Correlate and compute**

Match ordered ingress pieces to render markers by turn and cumulative character count. For a batched React commit, assign its timestamp to every newly included piece.

```text
L(t,p) = renderedAt(t,p) - rustIngressAt(t,p)
B = p95(L(1,p), excluding the first warm-up piece)
```

- [ ] **Step 3: Apply the verdict**

```text
p95(L(turns 2..10)) <= B + 50 ms
p95(L(turn 10)) - p95(L(turn 1)) <= 50 ms
listener delta after hang-up = 0
timer delta after hang-up = 0
```

If these pass, make no Rust latency change. If Rust ingress becomes late, write a failing Rust test at that boundary. If ingress is timely but render is late, write the smallest failing Vitest. Never apply both fixes speculatively.

- [ ] **Step 4: Commit only a proven fix**

The optional fix commit includes its failing test and at most three files, using this exact message when the measured boundary is the React render queue:

```bash
git commit -m "fix(voice): prevent live transcript render backlog"
```

---

### Task 3: Bound the transcript and render honest states

**Files:**
- Modify: `frontend-react/src/components/chat/CallOverlay.tsx`
- Create: `frontend-react/src/components/chat/__tests__/CallOverlay.test.tsx`
- Modify: `frontend-react/src/components/chat/ChatInput.tsx`

**Interfaces:**
- Consumes: complete `heard`, `phase`, `notice`, Live-only `transcribing`.
- Produces: `compactCallTranscript(text, maxChars = 280): string`, three-line display, honest Transcribing/Disconnected title.

- [ ] **Step 1: Write the five-line word-boundary golden test**

```ts
it('keeps only complete trailing words within 280 characters', () => {
  const fiveLines = [
    'primul rând conține context care trebuie eliminat',
    'al doilea rând împinge frontiera în mijlocul unui cuvânt',
    'al treilea rând continuă promptul foarte lung',
    'al patrulea rând păstrează cuvintele întregi',
    'ultimul rând este partea pe care apelul trebuie să o arate',
  ].join('\n').repeat(3);
  const compact = compactCallTranscript(fiveLines);
  expect(compact.startsWith('… ')).toBe(true);
  expect(compact.length).toBeLessThanOrEqual(280);
  expect(compact).toMatch(/^…\s+\S+(?:\s+\S+)*$/);
  expect(fiveLines.replace(/\s+/g, ' ').trim().endsWith(compact.slice(2))).toBe(true);
});
```

Also assert a single over-budget token returns `…` and a short input remains unchanged after whitespace normalization.

- [ ] **Step 2: Write component-state and geometry tests**

Mock `MoltenOrb` and `useLiveToolActivity`. Render a 10,000-character `heard` value and assert `line-clamp-3`, full `aria-label`, and compact visible text. Render `transcribing={true}` and assert `Transcribing…`. Render `phase="ready"` with a close notice and assert no `Listening…` plus the disconnected label/reason.

- [ ] **Step 3: Run and observe failure**

```bash
cd frontend-react && bunx vitest run src/components/chat/__tests__/CallOverlay.test.tsx
```

- [ ] **Step 4: Implement the pure helper**

```ts
export function compactCallTranscript(text: string, maxChars = 280): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  if (maxChars <= 1) return '…'.slice(0, Math.max(0, maxChars));
  const tail = normalized.slice(-(maxChars - 2));
  const boundary = tail.indexOf(' ');
  if (boundary < 0) return '…';
  const completeTail = tail.slice(boundary + 1).trim();
  return completeTail ? `… ${completeTail}` : '…';
}
```

- [ ] **Step 5: Wire the state without extending protected `CallPhase`**

Add optional `transcribing` to `CallOverlay`. Pass from `ChatInput`:

```tsx
transcribing={callEngine === 'live' && liveCall.transcribing}
```

Title precedence:

```ts
const title =
  phase === 'ready' && notice ? t('call.liveClosed')
  : transcribing ? t('voice.transcribing')
  : listening ? t('call.listening')
  : phase === 'thinking' ? t(live ? 'call.liveConnecting' : 'call.thinking')
  : speaking ? t('call.speaking')
  : t('call.title');
```

Compact DOM:

```tsx
<p
  data-testid="call-transcript"
  aria-label={heard || undefined}
  className="line-clamp-3 max-h-[4.5rem] max-w-xl overflow-hidden break-words text-lg font-light leading-6 text-text-muted"
>
  {heard && phase !== 'ready' ? `“${compactCallTranscript(heard)}”` : t('call.prompt')}
</p>
```

- [ ] **Step 6: Verify and commit**

```bash
cd frontend-react && bunx vitest run src/components/chat/__tests__/CallOverlay.test.tsx src/hooks/__tests__/useLiveCallSession.test.ts
cd frontend-react && bunx tsc --noEmit
git add frontend-react/src/components/chat/CallOverlay.tsx frontend-react/src/components/chat/__tests__/CallOverlay.test.tsx frontend-react/src/components/chat/ChatInput.tsx
git commit -m "fix(voice): keep live transcript compact and honest"
```

---

### Task 4: Propagate a Live-owned tool trace through Rust

**Files:**
- Modify: `crates/feral-core/src/live/bridge.rs`
- Modify: `src-tauri/src/commands/live.rs`
- Modify: `src-tauri/src/events.rs`

**Interfaces:**
- Consumes: generated sidecar message id and existing sidecar `traceId`.
- Produces: `LiveStatusEvent.trace_id: Option<String>` shared by `toolCall`, sidecar events, and `toolResult`.

- [ ] **Step 1: Write failing tests for supplied ids and serialization**

In `bridge.rs`, test a pure id selector:

```rust
fn message_id(supplied: Option<&str>) -> String {
    supplied.map(str::to_owned).unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
}

#[test]
fn a_live_supplied_message_id_is_preserved() {
    assert_eq!(message_id(Some("live-trace-7")), "live-trace-7");
    assert!(!message_id(None).is_empty());
}
```

In `events.rs`, assert JSON contains `traceId` for `Some` and omits it for `None`.

- [ ] **Step 2: Run the failing focused tests**

```bash
cargo test -p feral-core live::bridge::tests::a_live_supplied_message_id_is_preserved
cargo test -p feral live_status_serializes_optional_trace_id
```

The desktop package is `feral` and the core package is `feral-core`, as declared by their current `Cargo.toml` files.

- [ ] **Step 3: Extend the event and bridge contracts**

```rust
#[serde(skip_serializing_if = "Option::is_none")]
pub trace_id: Option<String>,
```

Change `ask_feral` and `answer` to accept `supplied_message_id: Option<&str>`. Existing test callers pass `None`. The Live pump creates one UUID per outer tool call, emits it in `toolCall`, passes it to `bridge::answer`, and emits it in `toolResult`:

```rust
let trace_id = uuid::Uuid::new_v4().to_string();
let finished = bridge::answer(&owned_call, Some(&rt), &sid, Some(&trace_id)).await;
```

All non-tool Live statuses set `trace_id: None`. Keep the id local to the spawned call task.

- [ ] **Step 4: Verify and commit**

```bash
cargo test -p feral-core live::bridge
cargo check --workspace
git add crates/feral-core/src/live/bridge.rs src-tauri/src/commands/live.rs src-tauri/src/events.rs
git commit -m "fix(voice): correlate live tool requests in Rust"
```

---

### Task 5: Reject cross-surface tools and prove zero-retention soak

**Files:**
- Modify: `frontend-react/src/lib/tauri/events.ts`
- Modify: `frontend-react/src/hooks/useLiveToolActivity.ts`
- Modify: `frontend-react/src/hooks/__tests__/useLiveToolActivity.test.ts`

**Interfaces:**
- Consumes: optional Live `traceId`, raw sidecar `id`/`traceId`, current chat session and call engine.
- Produces: Live activity only for active current-call traces; Pipeline preserves current behavior.

- [ ] **Step 1: Add Live and raw-event test harnesses**

Retain existing parser tests. Add callback sets for both event sources and helpers:

```ts
function emitLive(kind: string, traceId: string, sessionId = 'voice-session') {
  act(() => liveCallbacks.forEach((callback) => callback({
    payload: { sessionId, kind, text: 'search Cinderpaw', traceId },
  })));
}

function emitTool(type: 'tool_start' | 'tool_done', traceId: string) {
  act(() => agentCallbacks.forEach((callback) => callback({ payload: { data: JSON.stringify({
    type, id: traceId, traceId, tool: 'web_search',
    args: { query: 'Cinderpaw' }, result: { ok: true },
  }) } })));
}
```

- [ ] **Step 2: Write the failing negative cross-surface test**

```ts
it('ignores cron and connector tools during a Live call', () => {
  const { result } = renderHook(() => useLiveToolActivity(true));
  emitLive('toolCall', 'live-trace');
  emitTool('tool_start', 'cron-trace');
  expect(result.current.some((row) => row.tool === 'web_search')).toBe(false);
  emitTool('tool_start', 'live-trace');
  expect(result.current.some((row) => row.tool === 'web_search' && row.status === 'running')).toBe(true);
});
```

Add mismatched Live session, matched completion/failure, malformed JSON, and cleanup tests.

- [ ] **Step 3: Run and observe the current leak**

```bash
cd frontend-react && bunx vitest run src/hooks/__tests__/useLiveToolActivity.test.ts
```

Expected: the cron row appears because the raw bus is currently accepted globally.

- [ ] **Step 4: Extend the frontend event type**

```ts
export interface LiveStatusEvent {
  sessionId: string;
  kind: string;
  text: string;
  traceId?: string | null;
}
```

- [ ] **Step 5: Gate Live events by active trace**

Read current `sessionId` and whether `callEngine === 'live'` from existing stores. Maintain `activeTracesRef = useRef(new Set<string>())`. On current-session `toolCall`, add its trace and start `ask_feral`; on `toolResult`, retire that exact trace. For raw lines:

```ts
const traceId =
  typeof line.traceId === 'string' ? line.traceId
  : typeof line.id === 'string' ? line.id
  : '';
if (requireLiveTrace && (!traceId || !activeTracesRef.current.has(traceId))) return;
```

Add `traceId: string | null` to `ToolActivity`, correlate updates by tool plus trace, and clear the set on disable/cleanup. In Pipeline mode retain the current raw-event behavior.

- [ ] **Step 6: Add the accelerated three-hour-equivalent verdict**

Use fake time and thousands of matched/unmatched events across repeated mounts. Final assertions:

```ts
expect(liveCallbacks.size).toBe(0);
expect(agentCallbacks.size).toBe(0);
expect(vi.getTimerCount()).toBe(0);
expect(lastRows).toEqual([]);
```

Pair with the Task 1 repeated-mount test to prove pending transcript rows, mic queue work after hang-up, timers, listeners, and active traces return to baseline. These are the application-owned zero-retention assertions; raw WebView heap bytes remain diagnostic per spec.

- [ ] **Step 7: Verify and commit**

```bash
cd frontend-react && bunx vitest run src/hooks/__tests__/useLiveToolActivity.test.ts src/hooks/__tests__/useLiveCallSession.test.ts src/components/chat/__tests__/CallOverlay.test.tsx
cd frontend-react && bunx tsc --noEmit
git add frontend-react/src/lib/tauri/events.ts frontend-react/src/hooks/useLiveToolActivity.ts frontend-react/src/hooks/__tests__/useLiveToolActivity.test.ts
git commit -m "fix(voice): isolate live tool activity by trace"
```

---

### Task 6: Verify the whole call and close project memory

**Files:**
- Modify after acceptance passes: `docs/agents-memory/project_voice_mode_followups.md`

**Interfaces:**
- Consumes: completed slices and measurements.
- Produces: truthful closed status with commit/file landing points and measured numbers.

- [ ] **Step 1: Run focused and repository gates**

```bash
cd frontend-react && bunx vitest run src/hooks/__tests__/useLiveCallSession.test.ts src/components/chat/__tests__/CallOverlay.test.tsx src/hooks/__tests__/useLiveToolActivity.test.ts
cargo test -p feral-core live::bridge
./scripts/verify.sh
```

- [ ] **Step 2: Visually verify the actual app**

Verify 1,000/10,000-character prompts remain three lines; full history is exact; delayed transcript shows Transcribing; forced close shows Disconnected; real tool success/failure is visible; unrelated cron/connector activity stays absent.

- [ ] **Step 3: Run the real 20-turn acceptance call**

Ask the user for microphone/key participation now. Record `B`, p95 turns 2–10, turn-10 minus turn-1, listener/timer deltas, one real tool success, one real failure, one barge-in, and final-history equality. Pass requires both `<= 50 ms` growth bounds and zero application-owned retained-state deltas.

- [ ] **Step 4: Update and commit project memory only after passing**

Change the note from open to closed; record date, commits, files, measurements, zero-delta soak verdict, and any separately scoped Pipeline observation without claiming Pipeline was fixed.

```bash
git add docs/agents-memory/project_voice_mode_followups.md
git commit -m "docs(voice): close live continuity follow-ups"
```

- [ ] **Step 5: Confirm final scope**

```bash
git status --short
git log --oneline -8
git diff HEAD~5..HEAD --stat
```

Confirm no protected Pipeline/VAD/audio file and no unrelated dirty file entered the commits.
