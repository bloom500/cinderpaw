# Feral Headless — the gateway

Run Feral as a background service with **no window**: same brain (memory, LoRA,
Dream Cycle, RSI, tools) as the desktop app, reachable over a small local HTTP
API and from the terminal. This is the "One Brain, Many Faces" runtime — the
desktop app, the connectors (Discord/Slack/…), and the CLI are all just faces on
the one process.

> Scope: Faza 4.5. macOS service install is a later phase; Windows and Linux are
> covered here.

## Quick start

```sh
feral doctor          # check the install is ready
feral gateway start   # start the gateway in the background
feral gateway status  # confirm it's up
feral chat            # talk to it from the terminal
feral gateway stop    # graceful shutdown
```

The gateway binds `127.0.0.1:11435` (loopback only — never the LAN) and every
request needs the bearer token in `~/.feral/api-token` (generated on first
boot). One port, one brain: if the desktop app is already running, the gateway
refuses to start a second host, and vice-versa.

## Commands

| Command | What it does |
|---|---|
| `feral gateway` | Run in the **foreground** (logs to stderr, Ctrl+C to stop). |
| `feral gateway start` | Start in the **background**; logs to `~/.feral/gateway.log`. |
| `feral gateway stop` | Graceful drain (finishes in-flight work, then exits). |
| `feral gateway restart` | Stop then start. |
| `feral gateway status` | Model, LoRA, backend, sidecar liveness. |
| `feral model` | List installed local models. |
| `feral doctor` | Diagnose: port, token, models, sidecar binary, GPU, connectors. |
| `feral chat` | Interactive terminal chat over `/runtime/chat`. |

`stop` works by asking the running gateway to shut down over HTTP
(`POST /runtime/shutdown`), so it's reliable across platforms and doesn't depend
on console signals reaching a detached process.

## Using a cloud provider (BYOK)

By default the gateway serves the bundled local model. To point the sidecar at a
provider you've configured in the desktop app instead (key read from the OS
keychain, never the command line):

```sh
FERAL_BYOK_PROVIDER=minimax feral gateway start
```

Explicit overrides still win and are useful for one-offs:

```sh
FERAL_BASE_URL=https://api.example.com FERAL_API_KEY=sk-… FERAL_MODEL=some-model feral gateway
```

`FERAL_API_KEY` is **required** for any non-loopback `FERAL_BASE_URL` — the
gateway refuses to forward the local bearer token to a remote host.

## The Public Runtime API

Loopback + bearer token. `Authorization: Bearer $(cat ~/.feral/api-token)`.

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
TOKEN=$(cat ~/.feral/api-token)
curl -sN -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST http://127.0.0.1:11435/runtime/chat \
  -d '{"content":"hello"}'
```

## Run it as a real service

So Discord (and the rest) answer after a reboot with nothing open.

**Windows** — a logon Task Scheduler task (native, no extra tooling):

```powershell
schtasks /create /tn "Feral Gateway" /sc onlogon /rl highest ^
  /tr "\"%LOCALAPPDATA%\Programs\feral\feral.exe\" gateway"
```

**Linux** — a systemd **user** unit at `~/.config/systemd/user/feral.service`:

```ini
[Unit]
Description=Feral Gateway
After=network-online.target

[Service]
ExecStart=%h/.local/bin/feral gateway
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now feral
loginctl enable-linger "$USER"   # keep it running when you're logged out
```

> `feral service install` will wrap these steps in a future update; for now the
> snippets above are the supported path.
