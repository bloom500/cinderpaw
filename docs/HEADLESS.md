# Cinderpaw Headless — the gateway

Run Cinderpaw as a background service with **no window**: same brain (memory, LoRA,
Dream Cycle, RSI, tools) as the desktop app, reachable over a small local HTTP
API and from the terminal. This is the "One Brain, Many Faces" runtime — the
desktop app, the connectors (Discord/Slack/…), and the CLI are all just faces on
the one process.

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
| `cinderpaw stop` | Stop Cinderpaw running in the background. |
| `cinderpaw gateway status` / `cinderpaw status` | Model, LoRA, backend, sidecar liveness. |
| `cinderpaw open` (alias `dashboard`) | Open Cinderpaw in your browser. |
| `cinderpaw ask "<question>"` | Ask one question and get the answer right here. |
| `cinderpaw sessions` (alias `transcripts`) | See your past chats, or read one. |
| `cinderpaw skills` | See the skills Cinderpaw knows, read one, or remove one. |
| `cinderpaw providers` (alias `provider`) | See your AI providers, pick one, or add a key. |
| `cinderpaw model` | List installed local models. |
| `cinderpaw doctor` | Diagnose: port, token, models, sidecar binary, GPU, connectors. |
| `cinderpaw logs [-f]` | Print (or follow) the gateway log. |
| `cinderpaw connectors [reload]` | List connectors, or reload `connectors.json` into a running gateway. |
| `cinderpaw dreams` | Watch the Dream Cycle live off the event stream. |
| `cinderpaw config get [key]` / `set <key> <value>` | Read/write `settings.json`. |
| `cinderpaw chat` (alias `tui`) | Interactive terminal chat over `/runtime/chat`. |
| `cinderpaw completion <shell>` | Print a shell-completion script (bash/zsh/fish/powershell/elvish). |
| `cinderpaw update` | Get the newest Cinderpaw. |
| `cinderpaw uninstall [--purge]` | Remove Cinderpaw. Your chats, memory, keys and models stay unless you add `--purge`. |
| `cinderpaw migrate` | Bring your setup over from OpenClaw or Hermes Agent. |

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

**The one-line install already does this.** `install.sh` and `install.ps1`
finish by running `cinderpaw self-install`, which makes Cinderpaw start when
you log in:

- **Windows:** a shortcut in your Startup folder that runs `cinderpaw gateway start`.
- **macOS:** a LaunchAgent at `~/Library/LaunchAgents/dev.cinderpaw.engine.plist`.
- **Linux:** a systemd user unit at `~/.config/systemd/user/cinderpaw.service`.
  If systemd is not there, an entry in `~/.config/autostart/` instead.

`cinderpaw uninstall` takes these away again.

On Linux, a user unit stops when you log out. To keep it running:

```sh
loginctl enable-linger "$USER"
```

**Installed with `install.sh --from-source`?** That path puts the CLI in
`~/.local/bin` and does not set up autostart. Add a systemd **user** unit at
`~/.config/systemd/user/cinderpaw.service` yourself:

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
