# Feral — Product Knowledge

> Loaded on demand via the `product_info` tool. This is the agent's factual
> reference for questions about Feral itself — what it is, how to set it up,
> how connectors/models/commands work. Answer from THIS document, not from
> guesses. If something isn't covered here, say so and point the user to
> `feral doctor`, `feral logs`, or the docs instead of inventing behavior.

## What is Feral

Feral is a local-first personal AI agent by Bloom Media. It runs on the
user's own machine: a desktop app, a terminal chat (TUI), and a `feral` CLI
all talk to the same local runtime (the "gateway", port 11435 on 127.0.0.1).
The model can be a fully local GGUF model (llama.cpp, GPU via Vulkan/Metal
with CPU fallback) or a cloud provider the user brings a key for (BYOK).
Feral adapts to its owner over time: persistent cross-session memory, dream
cycles (background reflection), and eval-gated on-device LoRA personalization.

## Surfaces

- **Desktop app** — chat, connectors page, local models, memory, extensions.
- **Terminal chat** — `feral` or `feral chat` opens the TUI.
- **CLI** — `feral <command>` for admin tasks (see Commands below).

## First-time setup (onboarding)

- `feral setup` — guided flow: detects AI the user can already use (existing
  provider keys, configured models, local GGUF files on disk), live-tests the
  best candidate with a REAL completion, persists only a verified route, then
  offers to open chat. ~4 interactions on the happy path.
- `feral setup --classic` — full step-by-step wizard (hardware probe, local
  vs cloud choice, model download, provider key, health checks).
- The desktop app runs an equivalent onboarding wizard on first launch.
- A one-time security acknowledgement is shown: Feral runs with the user's
  permissions, so shared/multi-user machines should be locked down.

## Connectors (Discord, WhatsApp, Slack, Telegram)

Connectors let the agent talk on chat platforms. Configuration lives in
`~/.feral/connectors.json`; secrets are stored per-connector.

**You can connect yourself.** When the user asks you to hook up Discord,
Slack, or WhatsApp, use the `connectors_manage` tool: `action:"list"` shows
what each connector needs; `action:"configure"` saves the config and applies
it immediately. Ask the user for the required secrets (e.g. the Discord bot
token), then configure it yourself — do not send them to the settings UI
unless they prefer that. WhatsApp needs no secret: enable it, then tell the
user to scan the QR code shown in the app (Connectors page or TUI).

The user can also do it manually — in the terminal chat:
- `/connectors` — list configured connectors and their state.
- `/connectors add discord DISCORD_TOKEN=<bot token>` — add Discord (create
  a bot in the Discord Developer Portal, invite it to a server, paste its
  token). `allowlist` restricts which user ids may talk to the agent.
- `/connectors add whatsapp` — starts QR pairing; scan the QR with WhatsApp
  on the phone (Linked devices). `/connectors qr` re-shows the current QR
  (it rotates every ~20s).
- `/connectors reload` — make the runtime re-read connectors.json.

From the CLI: `feral connectors` (list), `feral connectors set <id> …`,
`feral connectors reload`. In the desktop app: the Connectors page.
Telegram is not live yet (coming soon).

WhatsApp supports an optional "public" mode (restricted persona for
business/sales use); default is "owner" mode (only the owner's numbers).

## Models & providers

- `/model` in chat — list installed/configured models and switch live.
  Local entries are plain GGUF names; cloud entries are `provider:model`.
- Local models: GGUF files run by the bundled llama.cpp runtime (GPU when
  available, CPU fallback). Downloadable during setup.
- Cloud (BYOK): OpenAI-compatible providers (e.g. MiniMax, NVIDIA NIM),
  Anthropic. Keys are collected during setup and kept out of plain config.
- Brain Stack: the runtime can route each task to the best configured model
  (cost/health-aware). `routed to <model>` lines in chat show the routing.

## Memory & adaptation

- Persistent memory across sessions, models, and providers (episodic store +
  retrieval). `/memory` shows stats; `/memory search <q>` searches.
- Dream cycles: background reflection that consolidates memory when idle.
  `/dream` shows the last cycle; `/dream now` triggers one.
- LoRA personalization: on-device fine-tuning proposals gated by eval
  (never auto-applied blind). `/lora` shows training status.
- RSI (recursive self-improvement): config/code proposals with watchdog
  auto-revert on crash; `feral meta` inspects meta-evolution state.

## Chat slash commands

`/help` (all commands + keys), `/model`, `/connectors`, `/memory`, `/dream`,
`/lora`, `/tools` (tool-call browser), `/status`, `/doctor`, `/providers`,
`/compact` (summarize older context), `/think` (toggle reasoning visibility),
`/verbose on|off` (runtime event lines), `/usage off|tokens|full` (per-reply
token footnote), `/restart` (restart the runtime).

## CLI commands

`feral` (chat), `feral setup [--classic]`, `feral gateway start|stop|restart|status`,
`feral status`, `feral doctor` (health checks), `feral logs [-f]`,
`feral model`, `feral connectors …`, `feral dreams`, `feral meta …`,
`feral config get|set`, `feral completion <shell>`.

## Files & troubleshooting

- `~/.feral/` — settings.json, connectors.json, api-token, gateway.log,
  optional SOUL.md override (personality).
- Something broken? `feral doctor` runs health checks; `feral logs` shows
  the gateway log; `feral gateway restart` restarts the runtime.
- The gateway listens only on 127.0.0.1:11435 with a bearer token — nothing
  is exposed to the network.

## What Feral is NOT

- Not a cloud service: conversations, memory, and models stay on-device
  unless the user configures a cloud model provider.
- No telemetry of chat content.
- The agent cannot edit files under `~/.feral` itself unless the user set
  the workspace to allow it — configuration changes go through the commands
  and surfaces above.
