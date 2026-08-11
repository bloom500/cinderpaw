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

## Connectors (Discord, WhatsApp, Slack)

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

## Working unattended (walk-away runs)

Feral is built to keep working when nobody is watching — a cron job, or a
message answered while its author is asleep. A turn that runs out of budget is
NOT the end of the task:

- **Automatic continuations.** When a turn hits the time limit with work left,
  the runtime starts another turn on the same session (transcript, task list and
  checkpoint all intact) and tells it to pick up where it stopped rather than
  start over. Budget: `FERAL_UNATTENDED_CONTINUATIONS`.
- **A wall-clock deadline.** `FERAL_MISSION_DEADLINE_MS` stops a run at a real
  time rather than after a number of turns.
- **One replan.** If the same action keeps returning the same result, the run is
  not "out of time", it is refuted — it gets exactly one turn to state what it
  tried, why it could not work, and choose a different approach. Once, not
  repeatedly: a second replan knows nothing the first did not.
- **A stall guard.** Three turns in a row that change no files and close no
  tasks stop the run instead of burning the budget. Progress is read off the
  disk, never from the agent's own opinion of itself.
- **Crash recovery.** A killed process leaves a run marked `running`; the next
  boot sees that and resumes it, up to a resume cap, then asks a human.

**Declaring what "done" means (`done_when:`).** Put a `done_when:` line anywhere
in the message and the run is judged by that check instead of by the agent's own
closing paragraph:

- `done_when: exists report.md` — the file is there.
- `done_when: contains report.md "Q3"` — the file is there and contains that text.
- `done_when: run npm test` — the command exits 0.

A run that claims success and fails its check is recorded as unfinished, told so
with the failure quoted at it, and sent back to work. Without a `done_when:` the
run is recorded as *unverified* rather than quietly as finished — "I'm done" is
the agent's opinion, and the check is the world's.

**The walk-away digest.** Every unattended run is reported with a verdict first
(done / done-but-the-check-failed / not finished), then turns and actions, then
what the commands actually did, then every file changed with a command to undo
it, and the agent's own words LAST. It is assembled from what the runtime
already recorded, so it costs no model call and cannot make things up.

## Keeping its place on a long task

Long runs fail by forgetting, not by being wrong. Four mechanisms, each covering
what the others lose:

- **The notebook.** `remember` with a key starting `note:` writes a durable note
  that is shown back in FULL at the start of every turn — not searched. Search
  only ever returns what the agent thought to look for, which late in a run is
  exactly what it has forgotten it knows. Capped at 10 entries, so it stays
  curated. `note:position` is the conventional "where I am, what is next, what
  is blocked" entry.
- **The task list.** `todo_write` stores tasks in the database, not the
  transcript. Both the open items AND recently finished ones are shown every
  turn — the finished half is what stops work being redone after the
  conversation that recorded it has been compacted away.
- **Compaction.** When the conversation outgrows its budget, older turns are
  summarized into one note carrying an exact `### Established facts` section.
  Summaries are carried forward verbatim, never re-summarized. `/compact`
  triggers it manually.
- **The scratchpad.** `~/.feral/workspace` is the agent's own directory. It
  writes there freely with `write_file` and `edit_file` — running notes, drafts
  of long output, intermediate results — without touching anything of the
  user's. The desktop shows what it wrote as `1 scratchpad edit +71` under the
  reply, and that line persists.

Writing in the USER's directories is deliberately stricter: only inside the
configured workspace roots, and `edit_file` / `write_file` both refuse to
overwrite a file the agent has not read first — an unread overwrite destroys
whatever it did not know was there.

## Asking the agent about itself

Do not answer from memory about the runtime's current state — ask it:

- `self_tools` — every tool actually registered right now, with descriptions.
  This is generated from the live registry, so it is never out of date.
- `self_describe` — full runtime identity document, all subsystems at once.
- `self_status` / `self_health` — per-subsystem heartbeat and availability.
- `self_subsystem <name>` — deep dive on one subsystem.
- `self_runtime`, `self_providers`, `self_memory`, `self_connectors`,
  `self_genome`, `self_dreams`, `self_lora`, `self_progress` — narrower views.

The rule the substrate is built on: nothing may be invisible to the agent. If a
question is about what Feral IS, answer from this document; if it is about what
this instance is DOING or HAS, call the matching `self_*` tool and answer from
the result.

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
- **"feral-agent not running" in the desktop app, and reinstalling changes
  nothing.** The usual cause is a SECOND Feral already running on this machine —
  typically a CLI `feral gateway` started in a terminal. One profile holds one
  exclusive lock on the memory database (`~/.feral/agent/.writer.lock`, stamped
  with the owning process id), so the app's own sidecar cannot open it and dies
  at startup. Fix: `feral gateway stop`, or close the other Feral, then restart
  the app. Two instances that genuinely need to coexist need separate profiles —
  a different `FERAL_HOME` and a different `api_port` each.
- **The banner does not clear by itself.** After the runtime comes back, the
  "went offline" message can stay on screen until the app is restarted — and
  closing the window is not enough, since it keeps running in the system tray.
  Quit from the tray icon, then reopen.

## What Feral is NOT

- Not a cloud service: conversations, memory, and models stay on-device
  unless the user configures a cloud model provider.
- No telemetry of chat content.
- Not unsupervised in the user's project by default: writes are refused
  outside the configured workspace roots, and the agent must read a file
  before it may overwrite it.
- The agent cannot edit its own settings, memory database, or identity files
  under `~/.feral` — configuration changes go through the commands and
  surfaces above. The ONE exception is `~/.feral/workspace`, its scratchpad,
  which is writable by design and holds nothing of the user's.
