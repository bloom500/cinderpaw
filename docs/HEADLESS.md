# Cinderpaw Headless — the gateway

Run Cinderpaw as a background service with **no window**: same brain (memory, LoRA,
Dream Cycle, RSI, tools) as the desktop app, reachable over a small local HTTP
API and from the terminal. This is the "One Brain, Many Faces" runtime — the
desktop app, the connectors (Discord/Slack/…), and the CLI are all just faces on
the one process.

> Scope: Faza 4.5. macOS service install is a later phase; Windows and Linux are
> covered here.

## Quick start

```sh
cinderpaw doctor          # check the install is ready
cinderpaw gateway start   # start the gateway in the background
cinderpaw gateway status  # confirm it's up
cinderpaw chat            # talk to it from the terminal
cinderpaw gateway stop    # graceful shutdown
```

The gateway binds `127.0.0.1:11435` (loopback only — never the LAN) and every
request needs the bearer token in `~/.cinderpaw/api-token` (generated on first
boot). One port, one brain: if the desktop app is already running, the gateway
refuses to start a second host, and vice-versa.

## Commands

| Command | What it does |
|---|---|
| `cinderpaw gateway` | Run in the **foreground** (logs to stderr, Ctrl+C to stop). |
| `cinderpaw gateway start` | Start in the **background**; logs to `~/.cinderpaw/gateway.log`. |
| `cinderpaw gateway stop` | Graceful drain (finishes in-flight work, then exits). |
| `cinderpaw gateway restart` | Stop then start. |
| `cinderpaw gateway status` / `cinderpaw status` | Model, LoRA, backend, sidecar liveness. |
| `cinderpaw model` | List installed local models. |
| `cinderpaw doctor` | Diagnose: port, token, models, sidecar binary, GPU, connectors. |
| `cinderpaw logs [-f]` | Print (or follow) the gateway log. |
| `cinderpaw connectors [reload]` | List connectors, or reload `connectors.json` into a running gateway. |
| `cinderpaw dreams` | Watch the Dream Cycle live off the event stream. |
| `cinderpaw config get [key]` / `set <key> <value>` | Read/write `settings.json`. |
| `cinderpaw chat` (alias `tui`) | Interactive terminal chat over `/runtime/chat`. |
| `cinderpaw completion <shell>` | Print a shell-completion script (bash/zsh/fish/powershell/elvish). |

Global flags: `--json` (machine-readable output on the read commands),
`--no-color` (also auto-off when piped or `NO_COLOR` is set), `-V`/`--version`.

`stop` works by asking the running gateway to shut down over HTTP
(`POST /runtime/shutdown`), so it's reliable across platforms and doesn't depend
on console signals reaching a detached process.

## Using a cloud provider (BYOK)

By default the gateway serves the bundled local model. To point the sidecar at a
provider you've configured in the desktop app instead (key read from the OS
keychain, never the command line):

```sh
CINDERPAW_BYOK_PROVIDER=minimax cinderpaw gateway start
```

Explicit overrides still win and are useful for one-offs:

```sh
CINDERPAW_BASE_URL=https://api.example.com CINDERPAW_API_KEY=sk-… CINDERPAW_MODEL=some-model cinderpaw gateway
```

`CINDERPAW_API_KEY` is **required** for any non-loopback `CINDERPAW_BASE_URL` — the
gateway refuses to forward the local bearer token to a remote host.

## The Public Runtime API

Loopback + bearer token. `Authorization: Bearer $(cat ~/.cinderpaw/api-token)`.

| Endpoint | |
|---|---|
| `POST /runtime/chat` | Chat a turn (SSE stream by default); `{ content, session_id? }`. |
| `GET /runtime/status` | Model, LoRA, sidecar, backend, RSI engine. |
| `GET /runtime/models` | Installed models + active. |
| `GET /runtime/lora` | Active adapter. |
| `GET /runtime/manifest` | Declarative snapshot (version, models, providers, …). |
| `GET /events` | Unified observability SSE (dreams, memory, tools, RSI). |
| `POST /runtime/shutdown` | Graceful shutdown. |

```sh
TOKEN=$(cat ~/.cinderpaw/api-token)
curl -sN -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST http://127.0.0.1:11435/runtime/chat \
  -d '{"content":"hello"}'
```

## Run it as a real service

So Discord (and the rest) answer after a reboot with nothing open.

**Windows** — a logon Task Scheduler task (native, no extra tooling):

```powershell
schtasks /create /tn "Cinderpaw Gateway" /sc onlogon /rl highest ^
  /tr "\"%LOCALAPPDATA%\Programs\Cinderpaw\cinderpaw.exe\" gateway"
```

**Linux** — a systemd **user** unit at `~/.config/systemd/user/cinderpaw.service`:

```ini
[Unit]
Description=Cinderpaw Gateway
After=network-online.target

[Service]
ExecStart=%h/.local/bin/cinderpaw gateway
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now cinderpaw
loginctl enable-linger "$USER"   # keep it running when you're logged out
```

> `cinderpaw service install` will wrap these steps in a future update; for now the
> snippets above are the supported path.
