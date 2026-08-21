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

- **The media path under load.** The spike moves no audio. It proves the
  peer connection establishes, not that a call sounds good.
- **Cold start.** Server boot plus worker registration plus the EOT model load
  was a few seconds in the spike. Whether that is warm-started at app boot or
  paid on the first call is a Phase 2 decision.
- **BYOK key mapping.** Each plugin wants its vendor's key in its own format;
  Cinderpaw stores generic API keys. Still needs a mapping layer.
- **Licensing.** LiveKit server is Apache 2.0. Bundling the binary means
  distributing Apache 2.0 code, so a NOTICE entry is required. Trivial, but
  not done yet.

## Next

Phase 2 (feature parity) as described in `BUGS-HANDOFF-OPUS.md`, with two
amendments from the findings above: the worker is a Node process rather than
part of the Bun sidecar, and macOS needs a source build before it can ship.
