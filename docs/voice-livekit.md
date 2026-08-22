# Voice engine on LiveKit — Phase 1 findings

**Decision (Darius, 2026-08-21):** replace the hand-rolled Gemini Live voice
engine with LiveKit Agents, **self-hosted** — not LiveKit Cloud. Rationale: a
mature engine beats micro-fixes on ours, and LiveKit natively covers STT, TTS
and speech-to-speech.

**Status: Phase 1 gate PASSED on Windows.** Reproduce it yourself:

```
node scripts/livekit-spike.mjs
```

It downloads the server, boots it, installs the SDK, registers a worker,
dispatches a job, and asserts the agent is a live participant in the room. Exit
0 means the self-hosted path carries a call on this machine. It took three
tries to get there, and every one of the three is encoded in that file.

Nothing in the shipping app is wired to LiveKit yet. The current voice engine is
untouched and still works.

---

## What the spike proved

| Step | Result |
|---|---|
| LiveKit server binary runs on Windows | yes, v1.13.5 |
| Server binds loopback only | yes, with the config below |
| `@livekit/agents` worker registers | yes |
| Job dispatch reaches the worker | yes |
| Agent joins the room over WebRTC | yes — `agent-AJ_… (kind=AGENT, state=ACTIVE)` |
| Real audio reaches the agent | yes — 50 frames / 24000 samples, first run |

---

## Things that will bite, found by doing it

### 1. There is no macOS server build — this is a gate decision

LiveKit publishes `linux_amd64`, `linux_arm64`, `linux_armv7`, `windows_amd64`
and `windows_arm64`. **No darwin, on any recent release.** Checked v1.13.1
through v1.13.5.

Self-hosted-and-bundled therefore has no macOS story out of the box. Options:

- **Build from Go source in CI** and bundle our own darwin binary. Most work,
  keeps one architecture across all platforms, no user-visible difference.
- **`brew install livekit`** — LiveKit's own documented mac path. Not
  bundleable: a desktop app cannot require Homebrew.
- **Ship mac users a different mode** (user-hosted / Cloud) — splits the
  product in two and contradicts "your machine, your data" on exactly one
  platform.

Recommendation: build from source in CI. But this is a real cost that the
original handoff did not know about, and it is Darius's call.

### 2. Node is required for the worker — Bun is not enough

The handoff recommended folding voice into `CinderpawAgent` (Bun). Measured:

- Bun **can import** `@livekit/agents` (245 exports resolve).
- A worker under Bun **registers with the server**.
- The job then **dies**: `process exited before initializing (code 1)`.

The Agents SDK forks a supervised child process per job (`ipc/supervised_proc`),
and that fork does not come up under Bun on Windows. Registration succeeding
while jobs fail is the dangerous shape here — a smoke test that only checked
"did the worker connect" would have called this green.

So Phase 2 needs a Node runtime for the voice worker, spawned as its own
process, not `bun build --compile`'d into the existing sidecar. That changes the
Phase 2 plan and probably its estimate.

There are also platform-specific native modules in the tree
(`@livekit/av-win32-x64`, `local-inference-win32-x64-msvc`,
`rtc-ffi-bindings-win32-x64-msvc`), so the installer has to carry the right set
per target regardless of which runtime wins.

### 3. The default config puts a socket on the user's network

Out of the box the server binds the RTC port on **every** interface. The first
run of this spike had UDP 7882 listening on a public IPv6 address and on the
LAN address. On a desktop app that is not acceptable, and it is silent.

The config that is both local-only and actually works:

```yaml
port: 7880
bind_addresses:
  - 127.0.0.1
rtc:
  tcp_port: 7881
  port_range_start: 7882
  port_range_end: 7892
  use_external_ip: false
  node_ip: 127.0.0.1      # ← without this, ICE never completes
```

Two traps in there:

- **`rtc.interfaces.includes: [loopback]` looks right and breaks ICE.** It is
  the obvious way to say "local only". With it, the agent accepts the job and
  then dies with `wait_pc_connection timed out`. Narrow the *advertised*
  address (`node_ip`), not the enumerated interfaces.
- **`rtc.tcp_port` still binds `::`** even with `bind_addresses` set. Verify
  and firewall it before shipping; it is not covered by the loopback setting.

### 4. The binary is bigger than estimated

54 MB uncompressed, 18 MB as the release zip — the handoff assumed ~30 MB.
Per platform, plus the Node runtime and native modules from finding 2.

### 5. Good news: Fish Audio does not have to be dropped

`@livekit/agents-plugin-fishaudio` exists on npm. Handoff open question 6
("drop Fish for v1.0?") is answered — keep it, no plugin to write. Also
available: `silero` (VAD), `livekit` (their own turn-detection model),
`openai`, `google`, `anthropic`, `elevenlabs`, `cartesia`, `deepgram`.

### 6. Turn detection is a real local model

The worker loads `lk_eot_audio` — an end-of-turn inference runner — at startup,
locally. That is the direct answer to Bug 3 Hypothesis C (turn-detection window
too generous): it is a trained model, not a silence threshold.

---

## What is still unknown

- **The media path under load.** The spike now moves audio — a second
  participant publishes a 440 Hz tone and the agent receives it — but half a
  second of one tone is not a call. Duration, jitter and concurrency are
  untested.
- **Cold start.** Server boot plus worker registration plus the EOT model load
  was a few seconds in the spike. Whether that is warm-started at app boot or
  paid on the first call is a Phase 2 decision.
- **BYOK key mapping.** Each plugin wants its vendor's key in its own format;
  Cinderpaw stores generic API keys. Still needs a mapping layer.
- **Licensing.** LiveKit server is Apache 2.0. Bundling the binary means
  distributing Apache 2.0 code, so a NOTICE entry is required. Trivial, but
  not done yet.

## Decisions (Darius, 2026-08-22)

The spike also grew a step 6: a second participant publishes a synthetic tone
and the agent must receive real frames. It passed first run (50 frames, 24000
samples). Connecting and carrying audio are different claims, and only the
second one is worth anything.

Both Phase 1 gate questions are now answered. Do not re-open them without a
new measurement.

1. **macOS: build LiveKit server from Go source in CI.** One architecture on
   every platform, no Homebrew requirement, no mac-only "different mode".
   Implemented as `.github/workflows/livekit-macos.yml` — manual dispatch,
   builds `darwin_amd64` + `darwin_arm64` on native runners and uploads each
   as an artifact. Run it per LiveKit version bump. **Verified 2026-08-22:**
   both architectures build from source and the binary runs — `darwin_arm64`
   in 28s, `darwin_amd64` in 2m11s, each smoke-tested with `--version` on its
   own architecture. macOS is no longer a risk to this plan; it is a build
   step.

   One trap, paid for once: `macos-13` is a retired runner label, and a job
   asking for it does not fail — it queues forever. The Intel half sat
   unscheduled for 25 minutes while arm64 finished in under two, and that gap
   is the only signal GitHub gives. Use `macos-15-intel`.
2. **The voice worker is its own bundled Node process.** The Bun sidecar
   stays as it is. Cost accepted: a Node runtime plus the per-target native
   modules in the installer.

## Phase 2, first slice: confirmed in the app (2026-08-22)

Settings → General → "Voice call self-test" runs the whole chain inside the
shipping app: Rust boots the server on loopback, mints credentials, starts the
agent as a Node process, and the webview joins over WebRTC. **Darius ran it on
Windows and heard himself back.** No API key, no account, no downloaded model.

What that settles: the media path works through the real app, not just through
`scripts/livekit-spike.mjs`. WebView2 does WebRTC to a loopback server, the
microphone permission prompt behaves, and the process lifecycle holds.

What it does not settle: the far end echoes. It has no ears and no voice of its
own yet — a model is the next slice, and it plugs into a pipe that is now
proven rather than assumed.

## Phase 2, second slice: the brain (2026-08-22, same evening)

The far end is now Gemini's realtime API when a Google key is stored — the same
key, model (`gemini-2.5-flash-native-audio-latest`), voice (`Kore`) and spoken
briefing as `commands/live.rs`, which is the engine this replaces. Echo remains
for a machine with no key, labelled as an echo.

Three things learned building it:

- **STT and TTS never entered the picture, and that was the point.** A local
  pipeline was the first instinct — but `whisper` is not in the default feature
  set (so local STT ships in no build), and the only wired cloud STT is Groq,
  which needs a key this machine does not have. Gemini's realtime API replaces
  the whole STT → LLM → TTS chain with one session, which is why it was chosen
  originally and why it is still the right answer here.
- **A worker with no `agentName` is dispatched automatically** into every room
  that opens. That deletes the dispatch client the spike needed. The
  consequence: the room does not exist until the webview joins, so Rust waits
  for the worker to REGISTER rather than to be in the room.
- **"Connected" is not evidence.** The UI said connected while the far end was
  measured silent, and a second measurement during the greeting window was what
  distinguished "quiet right now" from "mute". Numbers, taken over the devtools
  protocol against the running app: remote track 9.4s after the button, first
  sound 5.1s later, peak amplitude 125/128. The first silent reading was a
  probe bug — a leaked `<audio>` element from a previous call — not the agent.

Not yet done: the assistant has no tools (`bridge::declarations()` is not wired
into the session), no transcripts reach the chat store, and the old engine is
still the one the Call button in chat uses. This lives in Settings.

Still open from the list above: the server binary is downloaded rather than
bundled, the agent needs Node plus one npm install on first run, BYOK key
mapping is unwritten, and the Apache 2.0 NOTICE entry is still missing.

## Next

Phase 2 (feature parity), amended by the decisions above:

- Node voice worker spawned as its own process from Tauri, not folded into
  the Bun sidecar.
- macOS ships once the CI workflow above has produced a binary that runs.
- Still unknown and unchanged by these decisions: the media path under load,
  cold-start placement, BYOK key mapping, and the Apache 2.0 NOTICE entry.

Note: the Phase 2 description this doc originally pointed at
(`BUGS-HANDOFF-OPUS.md`) is not in the repo. Phase 2 has no written plan yet.
