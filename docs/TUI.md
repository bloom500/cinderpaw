# Cinderpaw TUI — terminal chat

The TUI is the full-screen terminal chat client (Go + Bubble Tea). It talks to
the same gateway, sessions, memory and models as the desktop app — installing
one after the other adopts your existing `~/.feral` config with zero re-setup.

## Launching

```bash
feral          # plain `feral` in a terminal opens the chat TUI (OpenClaw-style)
feral chat     # same, explicit (auto-starts the gateway if it isn't running)
feral setup    # guided setup: detects AI you already have, verifies, saves
feral tui      # alias for `feral chat`
```

`feral chat` and `feral setup` shell out to the `feral-tui` binary that ships
next to the CLI. You can also run it directly:

| Flag | Effect |
|---|---|
| `--plain` | plain, non-interactive output (pipes, CI) |
| `--wizard` | force the classic step-by-step wizard even if already configured |

If the gateway isn't running, the TUI starts it and waits for the port. If it
can't, it tells you the manual command: `feral gateway start`.

## Slash commands

Type `/` to see completions. `F1` shows this list in-app (rendered from the
same registry that dispatches, so it can't drift).

| Command | Does |
|---|---|
| `/help`, `/?` | show the help overlay |
| `/tools` | browse tool calls + their results |
| `/new`, `/reset` | archive session and start fresh |
| `/clear`, `/cls` | clear this session's history |
| `/sessions`, `/history` | list recent sessions from disk |
| `/status` | show model, provider, uptime, tokens |
| `/whoami` | show session key and gateway info |
| `/usage [off\|tokens\|full]` | token count for this session; the mode sets the per-reply usage footer |
| `/context` | explain how context is assembled |
| `/tasks` | list background tool tasks |
| `/reasoning`, `/think` | toggle reasoning visibility |
| `/verbose [on\|off]` | show or hide runtime event lines |
| `/compact` | summarize older session context into a note (real LLM pass) |
| `/restart` | restart the gateway and reconnect |
| `/doctor` | run gateway health checks |
| `/providers` | list providers with health status |
| `/connectors add\|qr\|reload` | manage chat-platform connectors; `add whatsapp` starts QR pairing, `qr` reprints a fresh code |
| `/memory [search <q>]` | memory stats / search |
| `/dream [now]` | dream summary; `/dream now` triggers one |
| `/lora` | LoRA training status |
| `/model [<id>\|status]` | model picker / switch / details |
| `/stop` | abort the current streaming run |
| `/setup [classic]` | re-run guided setup; `classic` opens the full step-by-step wizard |
| `/exit`, `/quit`, `:q` | quit |

## Keys

| Key | Does |
|---|---|
| `Enter` | send message / accept |
| `Shift+Enter` / `Ctrl+J` | newline |
| `Esc` | interrupt / close overlay / clear input |
| `Ctrl+C` | clear input; press twice to quit (`Ctrl+D` on empty input also quits) |
| `F1` | help overlay |
| `Ctrl+R` | toggle thinking pane |
| `Ctrl+L` | clear screen |
| `PgUp` / `PgDn`, `Ctrl+Home` / `Ctrl+End` | scroll |
| `↑` / `↓` | move / input history |
| `Tab` | cycle completion |
| `y` / `n` | confirm / decline prompts |
| `r` | retry after an error |
| `j` / `k` | vim scroll in overlays |

While streaming, the footer shows live tokens / tokens-per-second and a cancel
hint; during model downloads it shows `↓ name 38% · 1.6/4.1 GB · 12 MB/s`.

## First run — guided setup

On a fresh install the TUI opens the GUIDED flow (same shape as `feral setup`
and OpenClaw's default onboarding): a one-time security acknowledgement, then
"Looking for AI you can already use…" — the server-side detection ladder
(existing config → local GGUFs on disk → hardware-tier download → env keys →
Ollama → OpenClaw import) — then a real-completion test of the first
candidate. Only a verified route is persisted. On failure you get a menu
(retry / download the recommended local model / paste an API key / classic
wizard / skip), never a dead end. The classic step-by-step wizard stays
behind `/setup classic` and `--wizard`.

The classic wizard is resumable — progress persists in
`~/.feral/.wizard-progress`, so quitting mid-setup continues where you left
off.

## Building from source

```bash
cd tui
go build -o feral-tui.exe .   # drop the .exe suffix on macOS/Linux
go test ./...
```

Put the resulting binary next to the `feral` CLI binary (that's where
`feral chat` looks for it). The TUI is an API client only — it needs a running
gateway (or lets `feral chat` start one) and has no other local dependencies.
