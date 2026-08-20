<p align="center">
  <img src="frontend-react/public/README%20banner.jpeg" alt="Feral — your local-first AI workspace" width="100%" />
</p>

# Feral

**Your local-first AI workspace. No subscription. No telemetry. No middleman.**

<p align="center">
  <a href="https://github.com/bloom500/feral/releases/latest"><img src="https://img.shields.io/github/v/release/bloom500/feral?style=for-the-badge&color=blue&label=version" alt="Version" /></a>
  <img src="https://img.shields.io/badge/license-BSL%201.1-green?style=for-the-badge" alt="License" />
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=for-the-badge" alt="Platform" />
  <img src="https://img.shields.io/badge/built%20with-Tauri%202-orange?style=for-the-badge&logo=tauri" alt="Tauri" />
</p>

<p align="center">
  <a href="https://x.com/BloomMedia66730"><img src="https://img.shields.io/badge/Follow-%40BloomMedia66730-black?style=for-the-badge&logo=x" alt="X/Twitter" /></a>
  <a href="https://github.com/bloom500/feral"><img src="https://img.shields.io/badge/Source-GitHub-181717?style=for-the-badge&logo=github" alt="GitHub" /></a>
  <a href="https://github.com/bloom500/feral/discussions"><img src="https://img.shields.io/badge/Community-Discussions-purple?style=for-the-badge&logo=github" alt="Discussions" /></a>
</p>

[Download](https://github.com/bloom500/feral/releases/latest) · [Report an issue](https://github.com/bloom500/feral/issues) · [Discussions](https://github.com/bloom500/feral/discussions) · Discord: *coming soon* · Website: *coming soon*

---

Feral is a desktop app that runs AI on your machine. With local GGUF models, everything happens offline — no API bills, no data leaving your computer, and absolutely zero VC-funded "alignment" teams reading your conversations at 3am. Prefer frontier models? Plug in your own API keys (BYOK) and talk to OpenAI, Anthropic, Gemini and friends directly — your key, your bill, no proxy in between. Either way: chat, deploy a full agentic runtime with memory and tool-use, and run deep multi-step web research. It's your computer. Do whatever you want.

![Chat](frontend-react/public/READMEdemo1.png)

---

## Quick install

**One command, any Linux or macOS — the installer detects your system:**

```bash
curl -fsSL https://raw.githubusercontent.com/bloom500/feral/main/scripts/install.sh | bash
```

- **Linux with a display** → installs the latest desktop app (`.deb`/`.rpm`).
- **Linux headless (VPS/server)** → builds the `feral` CLI + gateway from source (no GPU toolchain needed). Force a mode with `| bash -s -- --headless` or `--desktop`.
- **macOS** → downloads the right `.dmg` for your chip, installs to /Applications, clears the quarantine flag.

**Windows 10/11** — download the latest `.exe` from
[Releases](https://github.com/bloom500/feral/releases/latest) and run it. Or, in
PowerShell:

```powershell
$a = (irm https://api.github.com/repos/bloom500/feral/releases/latest).assets | ? name -like '*x64-setup.exe' | select -First 1
iwr $a.browser_download_url -OutFile feral-setup.exe; .\feral-setup.exe
```

> SmartScreen may warn on first run (the installer isn't code-signed yet) — click **More info → Run anyway**.

Prefer to grab a file by hand? Every installer — Windows `.exe`, macOS `.dmg`,
Linux `.deb`/`.rpm` — is on the
[Releases page](https://github.com/bloom500/feral/releases/latest).

### Just the CLI (npm)

Want the terminal agent without the desktop app? One command, any OS:

```bash
npm install -g feral-agent
feral            # the command is `feral`; the package is `feral-agent`
```

npm pulls only the binary for your platform (Windows, macOS Intel/Apple Silicon,
or Linux x64). Then `feral setup` to configure, `feral chat` for the terminal
UI, `feral gateway start` to run it as a service.

`feral update` pulls the latest release and restarts the gateway, so a running
connector (Discord, Slack, …) picks up the new build instead of staying on the
old one until you notice. It knows how Feral got onto the machine — npm here,
a `git pull` + rebuild on a from-source server — and does the right one.

`feral uninstall` removes the binaries. **Your `~/.feral` stays**: settings,
memory, API keys and downloaded models, so reinstalling resumes instead of
starting over. `feral uninstall --purge` deletes that too (permanently).

> **Note:** the npm build is a **cloud/gateway CLI — it does not bundle the local
> llama.cpp inference engine.** Point it at a cloud provider (BYOK via
> `FERAL_BASE_URL` / `FERAL_API_KEY` / `FERAL_MODEL`) or at a running desktop
> Feral. For **local GGUF models on your own machine, install the desktop app**
> above — that's the build with the inference engine.

<details>
<summary><b>Headless server / CLI from source</b> (no npm, build it yourself)</summary>

Build the `feral` CLI + gateway from source — no GPU or llama.cpp compile needed.
Requires [Rust](https://rustup.rs) + [Bun](https://bun.sh).

```bash
# Build deps (Debian/Ubuntu). libdbus-1-dev is needed by the keyring crate:
sudo apt install -y build-essential pkg-config libssl-dev libdbus-1-dev cmake git curl

git clone --depth 1 https://github.com/bloom500/feral && cd feral
( cd FeralAgent && bun install --frozen-lockfile && bun run build )
# --no-default-features skips the local llama.cpp engine (the CLI's default
# `inference` feature) — on a server you point the gateway at a cloud
# provider via FERAL_BASE_URL/FERAL_API_KEY/FERAL_MODEL instead:
cargo build --release -p feral-cli --no-default-features
# The sidecar binary must sit NEXT TO the CLI:
mkdir -p ~/.local/bin
install target/release/feral-cli    ~/.local/bin/feral
install FeralAgent/dist/feral-agent ~/.local/bin/feral-agent
feral doctor && feral gateway start
```

</details>

See [docs/HEADLESS.md](docs/HEADLESS.md) for running the gateway as a systemd service, cloud keys via env (`FERAL_BASE_URL` / `FERAL_API_KEY` / `FERAL_MODEL`), and the HTTP API. Full install notes (hardware requirements, first-launch warnings per OS) are in [Install](#install) below.

---

## What's new

*Power-user preview. We're looking for testers and contributors.
[Start here](docs/CONTRIBUTING.md) if you want to help.*

- 📞 **Call Feral and talk to it.** Press the phone button and it answers out
  loud, in your language, interrupting and being interrupted the way a call
  works. It keeps every tool it has while it talks: your files, your memory of
  past conversations, the web. And it shows you the work as it happens: a browser,
  a terminal, a search widget lighting up for whatever it is actually doing.
- 🌙 **Self-improvement, unstuck.** The nightly loop had been promoting nothing
  since 10 July on every install, because three graders marked correct answers
  wrong (`H₂O` against `h2o`, JSON inside a code fence, and speed limits that
  measure the network rather than the candidate). Fixed and measured: champion
  score 24.2 → 41.0 on the first run. And when self-improvement is off because
  your model is a paid cloud one, Feral now says so on screen instead of in a
  log, with the switch and your spend cap next to it.
- 🔁 **A second cloud provider to fall over to** before dropping to the local
  engine, so one provider's bad ten minutes no longer ends the work.

- 🛑 **It stops when it's provably stuck.** If a tool returns byte-identical
  output for the same arguments twenty times, repeating it can't make progress,
  so the turn ends and names the tool, instead of burning up to 500 iterations
  on the same call. A tool whose output keeps changing (a build still running) is
  left alone: waiting isn't looping.
- 🔁 **Tool fallbacks actually fire.** A tool that declares a standby now falls
  back to it for the failures it was meant to cover, even when it also declares
  retries. Previously those two paths disagreed and you got the original error.
- 🧾 **The reliability claims now have tests behind them.** Surviving a restart,
  switching provider mid-session, resuming memory and writing memory each have
  regression tests proving the behaviour end to end, including a
  write → process restart → read round-trip. Previously several of these were
  backed by code review alone.

- 🧬 **Sub-agents.** The agent can hand a slice of work to a fresh sub-agent (`delegate_task`), run several in parallel, and stream their progress back live. A depth guard keeps it from recursively spawning itself.
- 🙋 **It asks before it guesses.** Hit a real fork in the road and Feral stops to ask you (`ask_user`) instead of guessing, and the question reaches you wherever you are: the desktop app, the `feral chat` TUI, or right in your Discord/Slack/WhatsApp channel.
- 🎓 **On-device LoRA training.** Fine-tune a personal adapter on your own hardware (Unsloth, with a graceful fallback), gated behind an A/B eval so a worse adapter never ships. Needs an NVIDIA GPU to train.
- 📦 **One-command install.** A single command detects your OS and sets everything up on Windows, macOS, and Linux (see [Quick install](#quick-install) above).
- 💬 **Connectors, with personas.** Talk to your agent from **WhatsApp** (QR pairing), **Discord**, and **Slack**; each connector can run its own persona (`--persona`), so the same Feral is a support bot in one channel and your personal agent in another.
- 🤖 **Agent unleashed.** The sandbox is allow-by-default: open web access (SSRF-guarded, rate-limited, audited), filesystem access across your home directory (with a hard deny-wall on `~/.feral`, `~/.ssh`, and anything you list in `FERAL_FS_DENY`), and shell access out of the box. Every knob still exists if you want to lock it down.
- 🧠 **Memory Layers + RSI.** See everything Feral remembers, grouped by recency; Feral tunes its own parameters while you're away and keeps only what measurably works.
- 🔑 **BYOK (Bring Your Own Key).** OpenAI, Anthropic, Google Gemini, DeepSeek, Groq, Mistral, OpenRouter, Kimi, GLM, MiniMax, or any custom endpoint.

Full details in the [CHANGELOG](CHANGELOG.md). Upgrading from **0.1.7 or older**? Read the [updater key migration notes](docs/UPDATER_KEY_MIGRATION.md) first.

---

## Install

Grab the latest installer from [Releases](https://github.com/bloom500/feral/releases/latest). No admin rights required. The built-in updater keeps you current after that.

| Platform | Installer | Status |
|---|---|---|
| **Windows 10/11** (x64) | `.msi` / `.exe` | 🟢 Stable — primary target |
| **macOS** (Apple Silicon, Intel) | `.dmg` | 🟡 Beta — CI-built, lightly tested on real hardware. [Report issues](https://github.com/bloom500/feral/issues). |
| **Linux** (Ubuntu/Debian) | `.deb` / `.rpm` | 🟡 Beta — CI-built, lightly tested. [Report issues](https://github.com/bloom500/feral/issues). |

> **Windows first launch:** the installer isn't code-signed yet (certificates cost real money and Feral is free), so SmartScreen may show *"Windows protected your PC"*. Click **More info → Run anyway**. The installer is built by public GitHub Actions CI from this repository — you can audit exactly what went into it.

> **macOS first launch:** Feral isn't notarized by Apple (yet), so macOS will warn you on first open. If you see *"Feral.app is damaged"* or *"can't be opened"*, run this once in Terminal and you're set:
> ```bash
> xattr -cr /Applications/Feral.app
> ```
> Then open Feral normally. This removes the quarantine flag macOS puts on downloaded apps — nothing is actually damaged.

> **macOS after an update:** if you saved cloud API keys before updating, macOS may ask for your Mac login password to let the new version access an item stored in `ai.bloom.feral.byok`. That's your saved API keys in the macOS Keychain — enter your Mac login password and click **Always Allow** (or just re-enter the key in Settings → Cloud Keys). This happens because Feral isn't Apple-notarized yet, so each update looks like a new app to the Keychain. It will go away once Feral ships with an Apple Developer certificate.

### Hardware requirements

Feral itself is lightweight — the models are what need muscle. You can skip local models entirely and run on cloud keys (BYOK) on any machine.

| | Minimum | Recommended |
|---|---|---|
| **RAM** | 8 GB (3–4B models at Q4) | 16 GB+ (7–8B models comfortably) |
| **GPU** | None — CPU inference works | Any Vulkan-capable GPU; 6 GB+ VRAM keeps 7–8B models fully on-GPU |
| **Disk** | ~500 MB app + 2–5 GB per model | SSD, 20 GB+ free if you like collecting models |

Every model card shows a **0–100 fitness score** for *your* hardware before you download — Feral tells you up front if a model will make your machine cry.

## Quick start

1. **Install and open Feral.** A short welcome wizard introduces the app — pick a name for yourself and your agent.
2. **Get a model** (either path works):
   - **Local:** open **Models → Browse**, pick a model, and click download — Feral pre-selects the quantization that best fits your hardware. Already have GGUF files? Drop them in via **Models → Local**.
   - **Cloud (BYOK):** open **Settings → Cloud Keys** and paste an API key — OpenAI, Anthropic, Google Gemini, DeepSeek, Groq, Mistral, OpenRouter, Kimi, GLM, MiniMax, or any custom OpenAI-compatible endpoint. Keys are stored locally and never proxied through anyone's server.
3. **Chat.** Or flip the composer toggle to **Agent mode** to unleash the sidecar: tool-use, persistent memory, file access, and web research.

For deep research, ask the agent something like *"Research the current state of open-source LLMs"* — it calls `deep_research` on its own and comes back with a cited Markdown report.

### Prefer the terminal?

The same brain is fully drivable headless: `feral chat` opens a full-screen
terminal chat (same sessions, memory and models as the desktop app), `feral setup`
runs the wizard, `feral gateway start` runs everything as a background service,
and `feral doctor` diagnoses the install. See [docs/TUI.md](docs/TUI.md) for the
terminal client and [docs/API.md](docs/API.md) for the local HTTP API.

| Dark mode | Connectors (Discord, Slack, …) | Memory Layers |
|---|---|---|
| ![Dark theme](frontend-react/public/READMEdemo2.png) | ![Connectors](frontend-react/public/READMEdemo3.png) | ![Memory Layers](frontend-react/public/READMEdemo5.png) |

## Privacy, honestly

- **Local models:** inference, conversations, and memory never leave your machine. No background network requests, no telemetry, no analytics — by design.
- **Cloud models (BYOK):** your messages go to the provider you configured (OpenAI, Anthropic, …) when — and only when — you hit send. Feral talks to their API directly with your key; nothing is routed through our servers, because we don't have any. Their privacy policy applies to what you send them.
- **Web tools:** agent tools like `web_search`, `deep_research`, and `fetch_url` make outbound requests (DuckDuckGo or your own SearXNG instance, Jina Reader, or any public site the agent needs) when the agent uses them — through an egress proxy with SSRF protection, rate limiting, and an audit log.
- **Update check:** once per launch, Feral asks GitHub Releases whether a newer version exists. Only the version request is sent — no usage data, no identifiers beyond a normal HTTP request. Turn it off in **Settings → General** for a fully offline app.

| | |
|---|---|
| ![Privacy settings](frontend-react/public/READMEdemo7.png) | ![General settings](frontend-react/public/READMEdemo4.png) |

---

## What's inside

| Feature | Description |
|---|---|
| **Chat** | Persistent conversations with any local or cloud model. Projects keep related chats grouped and sane. |
| **Agent Mode** | A full TypeScript sidecar agent with tool-use, 4-layer memory, and an agentic loop. It thinks. Sometimes too much. |
| **Memory Layers** | See everything Feral remembers about you — grouped by recency (Today / This Week / This Month / Older). Live RSI status and dream cycle history. |
| **RSI (Self-Improvement)** | Feral tunes its own parameters while you're away. Evolutionary algorithm tests configs, keeps what works. Early-stage, functional. |
| **Connectors** | Talk to your agent from WhatsApp (QR pairing), Discord, or Slack. Same brain, same memory — running on your machine, not a cloud. |
| **Deep Research** | Multi-step autonomous web research: searches, reads pages, extracts findings, synthesizes a cited Markdown report. Like having a very caffeinated research assistant who never sleeps. |
| **Local Models** | Load GGUF models from disk. One-click load/unload with live Active status and hardware fitness scoring. |
| **Model Fitness Scoring** | Every local model gets a 0–100 score across memory fit, quality, speed, and context window — so you stop loading models that make your CPU cry. |
| **Browse HuggingFace** | Search and download models inside the app. No terminal. No manual file moves. No accidentally running `rm -rf`. |
| **SkillHub** | Install, discover, and import skills that extend what the AI can do. Community tab ships with curated third-party skills. |
| **Cloud Keys (BYOK)** | Add your own API keys for OpenAI, Anthropic, Google Gemini, Kimi, GLM, MiniMax, DeepSeek, Groq, Mistral, OpenRouter, or any custom endpoint. The AI equivalent of "I have a guy." |
| **Privacy Tags** | Wrap anything in `<private>...</private>` and it never touches the memory database. Your secrets stay secret, unlike that one time you committed a `.env` file. |
| **Tool Health Monitor** | ECC-style per-tool success rates and latency tracking. The agent can literally diagnose its own failing tools. |
| **Workspace Scanner** | Detect hardcoded secrets, API keys, and code security anti-patterns before you accidentally push them to GitHub and ruin your week. |
| **Hardware Monitor** | Live GPU/VRAM/RAM readout and Vulkan detection in the title bar. |
| **Auto-updater** | Silent background update checks. One click to install. |

---

## Architecture

Feral has two runtime layers that talk to each other:

```
┌─────────────────────────────────────────────────────────┐
│  Tauri v2 (Rust)                                        │
│  ├── llama.cpp inference engine  (port 11435)           │
│  ├── OpenAI-compatible REST API  (/v1/chat/completions) │
│  ├── HuggingFace Hub client                             │
│  ├── Model scanner + downloader                         │
│  └── System info (CPU / GPU / VRAM)                     │
├─────────────────────────────────────────────────────────┤
│  React + TypeScript frontend (Vite)                     │
│  ├── Chat UI with streaming + thinking block rendering  │
│  ├── Agent/Chat mode toggle                             │
│  ├── Models page (local + HuggingFace browse)           │
│  ├── Model fitness scoring (llmfit-adapted)             │
│  └── SkillHub + Settings                                │
└─────────────────────────────────────────────────────────┘
         ↕ stdin/stdout JSON (newline-delimited)
┌─────────────────────────────────────────────────────────┐
│  Feral Agent (Bun / TypeScript sidecar)                 │
│  └── see below                                          │
└─────────────────────────────────────────────────────────┘
```

---

## Feral Agent — the agentic runtime

When you flip the toggle to **Agent mode**, your messages go to a Bun/TypeScript sidecar process instead of the Rust backend directly. This sidecar is where all the interesting stuff happens.

![Agent settings](frontend-react/public/READMEdemo6.png)

### Agent loop

```
user message
    │
    ▼
[Recall] inject relevant past memory (FTS5 + semantic facts)
    │
    ▼
[Inference] → stream tokens live to UI
    │
    ├── tool call detected? → execute via ToolRegistry → feed result back → loop
    └── no tool call?       → final answer, persist to memory, done
```

Up to 10 iterations per message (50 for complex multi-step tasks like deep research). Failed web/network tools retry with linear backoff and fall back through the `web_search → deep_research → read_webpage` chain. Token budgets are off by default — re-enable with `FERAL_BUDGET_DAY` / `FERAL_BUDGET_CONVERSATION`.

### Memory layers

Feral Agent has 4 memory layers that persist across sessions:

| Layer | Storage | What it stores |
|---|---|---|
| **Working** | RAM | Current conversation transcript. Auto-compresses old turns when over token budget. |
| **Episodic** | SQLite + FTS5 | Every message, tool result, and typed observation. Full-text searchable. |
| **Semantic** | SQLite | Durable user facts extracted after each turn: name, role, language, preferences, constraints. |
| **Recall Engine** | — | Unified retrieval: injects relevant episodic hits + all semantic facts before every inference call. |

**Privacy tags (from claude-mem):** wrap sensitive content in `<private>...</private>` and it's stripped before any episodic write. The model still sees it during the current turn — only the database never does.

**Observation types (from claude-mem):** after each turn, the extractor runs two async passes:
1. **Facts pass** → extracts `key: value` user facts into SemanticMemory
2. **Observation pass** → classifies the turn (`discovery` / `decision` / `bugfix` / `feature` / `change` / `task` / `preference`), extracts bullet-point findings + concepts, stores a typed `[obs:type]` entry in EpisodicMemory

**FTS5 query normalization:** NFKC normalization before tokenisation → accented characters (Romanian ș, ă, î, â and others) fold correctly into search queries.

### Sandbox

Every tool call passes through a security layer before execution:

The philosophy is **capable by default, restrictable by choice**: the agent can browse the open web and work across your files out of the box, while hard guarantees stay call-time enforced:

- **Manifest validation** — tools declare `permissions: ["fs:read" | "fs:write" | "network:outbound" | "process:spawn"]` at registration; undeclared permissions are blocked
- **Egress proxy** — all network requests go through `ctx.fetch()` (never raw `fetch()`), which blocks SSRF (loopback / private / link-local ranges, re-checked on every redirect hop), rate-limits (30 req/60s), and audits every call. Open to all public hosts by default; set `FERAL_FETCH_DOMAINS` / `FERAL_HTTP_DOMAINS` to restrict to an allowlist.
- **Filesystem deny wall** — file tools work across your workspace roots (launch dir + home by default, `FERAL_WORKSPACE` to restrict), but `~/.feral` (your agent's own config, memory, and keys), `~/.ssh`, and anything in `FERAL_FS_DENY` are refused at call time — always, regardless of roots. Directory traversal (`../`) is resolved before any disk access.
- **Audit log** — every tool call, network request, and inference call is written to SQLite

### Built-in tools

| Tool | Permissions | Description |
|---|---|---|
| `web_search` | `network:outbound` | Ranked web results, no setup needed: keyless via DuckDuckGo, paced at one query per 5s (`FERAL_DDG_MIN_INTERVAL_MS`) to stay under its rate limit. For search with no rate limit and no pacing delay, run a [SearXNG](https://docs.searxng.org/) instance and point `FERAL_SEARXNG_URL` at it: several engines, and queries that never leave your machine. DuckDuckGo then stays as the fallback if it goes down. |
| `read_webpage` | `network:outbound` | Extracts clean Markdown from any URL via Jina Reader (`r.jina.ai`). No API key required. |
| `deep_research` | `network:outbound` | DeepResearch-style iterative loop: plan → search (Jina Search) → select URLs → read pages → extract findings → repeat → synthesize cited Markdown report. 4–8 iterations. |
| `read_file` | `fs:read` | Read files from the workspace. 64 KB cap. |
| `write_file` | `fs:write` | Write files to the workspace. 1 MB cap. Creates intermediate directories. |
| `list_directory` | `fs:read` | List directory contents. 200 entries max. |
| `fetch_url` | `network:outbound` | Fetch any public URL (SSRF-guarded, rate-limited, audited). |
| `http_request` | `network:outbound` | Generic HTTP client for APIs — GET/POST/PUT/DELETE with headers and JSON bodies. |
| `shell_exec` | `process:spawn` | Run shell commands. On by default; disable with `FERAL_ENABLE_SHELL_EXEC=false`. |
| `delegate_task` | — | Hand a self-contained sub-task to a fresh sub-agent (optionally several in parallel) and stream its progress back. Depth-guarded against runaway recursion. |
| `ask_user` | — | Pause and ask you a question when the task genuinely forks — routed to wherever you are (desktop, TUI, or the connector channel) instead of guessing. |
| `connectors_manage` | — | The agent can list and configure its own messaging connectors (tokens are write-only — it can never read them back). |
| `tool_health` | — | ECC-style health report: success rates, average latency, recurring errors per tool. The agent can diagnose its own reliability. |
| `scan_workspace` | `fs:read` | ECC AgentShield-style scanner: detects hardcoded secrets (API keys, passwords, tokens, JWT) and code anti-patterns (`eval()`, `innerHTML=`, SQL injection, `dangerouslySetInnerHTML`). Never exposes secret values — only file paths and line numbers. |

### Tool observation telemetry (ECC)

Every tool call is appended to `data/tool-observations.jsonl` (append-only JSONL, human-readable):

```json
{"schemaVersion":"feral.tool-observation.v1","tool":"web_search","success":true,"durationMs":843,"error":null,"argsKeys":["query"],...}
```

The `tool_health` tool aggregates these into a health report:
- **🟢 healthy** — success rate ≥ 80%
- **🟡 watch** — 1+ failures, success rate < 80%
- **🔴 failing** — ≥ 2 failures and success rate < 60%

### Deep Research (DeepResearch-inspired)

`deep_research` implements the ReAct loop from Alibaba-NLP/DeepResearch, adapted for local models:

```
question
    │
    ▼  (up to N iterations)
[Plan]    LLM decides: search for X  OR  synthesize (enough info)
    │
    ▼
[Search]  Jina Search (s.jina.ai) → ranked results JSON
    │
    ▼
[Select]  LLM picks top 2–3 most relevant URLs
    │
    ▼
[Read]    Each URL fetched via Jina Reader (r.jina.ai) → clean Markdown
    │
    ▼
[Extract] LLM pulls 3–5 bullet-point findings per page
    │
    └── repeat ──┘
    │
    ▼
[Synthesize] Final Markdown report with inline citations [1][2] + Sources section
```

All requests go through the egress proxy (domain allowlist: `s.jina.ai`, `r.jina.ai`). Optional `FERAL_JINA_API_KEY` env var for higher rate limits.

### Model fitness scoring (llmfit-adapted)

Every model card in the Local Models tab shows a 0–100 fitness score across 4 weighted dimensions:

| Component | Weight | How it's calculated |
|---|---|---|
| **Fit** | 40% | Memory utilization efficiency. Sweet spot: 50–80% of available VRAM/RAM = 100 pts. Piecewise linear decay toward 0 as model approaches or exceeds capacity. |
| **Speed** | 30% | Estimated tok/s = bandwidth proxy / model size. GPU+Vulkan ≈ 400 GB/s, CPU ≈ 50 GB/s. Target: 30 tok/s = 100 pts. |
| **Quality** | 20% | Quantization rank (F32=110 → Q1=8), normalized to 0–100. |
| **Context** | 10% | Declared context window. ≥32K = 95 pts, ≥8K = 75 pts, ≥4K = 60 pts. |

Fit levels: **🟢 Perfect** (≥50% utilization, comfortable) · **🔵 Good** (under-utilizing or slightly tight) · **🟡 Marginal** (80–100% utilization) · **🔴 Too large** (exceeds capacity).

Hover the score bar on any model card to see the 4-component breakdown, memory utilization percentage, estimated tok/s, and run mode (GPU / CPU offload / CPU).

---

## Tech stack

| Layer | Technology |
|---|---|
| App shell | Rust + Tauri v2 |
| Frontend | React + TypeScript + Vite + Tailwind CSS |
| Local inference | llama.cpp (bundled) via OpenAI-compatible REST at `localhost:11435` |
| Agent sidecar | Bun + TypeScript (compiled to single binary via `bun build --compile`) |
| Agent memory | SQLite (via `bun:sqlite`) + FTS5 full-text index |
| Web research | DuckDuckGo by default, SearXNG when self-hosted (`web_search`) + Jina Reader (`read_webpage`/`deep_research`) |
| Model discovery | HuggingFace Hub API |
| Signing & updates | tauri-plugin-updater + minisign |

---

## Environment variables (Agent sidecar)

When launched by the desktop app, the sidecar is pointed at Feral's **own bundled llama.cpp engine** (the loopback API on port 11435, with the per-launch bearer token injected automatically) — **no Ollama required**. The `FERAL_PROVIDER` / `FERAL_BASE_URL` defaults below apply only when running the sidecar standalone.

| Variable | Default | Description |
|---|---|---|
| `FERAL_DB` | `data/feral.db` | SQLite path (`:memory:` for ephemeral) |
| `FERAL_WORKSPACE` | cwd + home | Path-list of filesystem roots. Unset = launch dir + your home dir; set it to RESTRICT |
| `FERAL_FS_DENY` | — | Extra paths file tools may never touch (on top of the built-in `~/.feral` + `~/.ssh` deny wall) |
| `FERAL_MODEL` | `qwen2.5:7b` | Model name (overridden to `feral-local` by the app) |
| `FERAL_BASE_URL` | `http://127.0.0.1:11435` | Inference endpoint — Feral's bundled llama.cpp engine |
| `FERAL_PROVIDER` | `openai_compatible` | Provider (`openai_compatible` or `ollama` for a legacy Ollama setup) |
| `FERAL_FALLBACK_BASE_URL` | `http://localhost:11434` | Fallback endpoint if the primary is unreachable (e.g. a local Ollama) |
| `FERAL_API_KEY` | — | Bearer token for the inference endpoint (app injects the local API token) |
| `FERAL_ENABLE_SHELL_EXEC` | `true` | Register the `shell_exec` tool. Set `false` to disable shell access entirely. |
| `FERAL_SHELL_WHITELIST` | `git,node,python,…` | Comma-separated binaries `shell_exec` may run |
| `FERAL_TOOL_GRAMMAR` | `false` | Grammar-constrain tool calls on the bundled engine (lazy GBNF) |
| `FERAL_SEARXNG_URL` | — | Origin of a [SearXNG](https://docs.searxng.org/) instance for `web_search` (e.g. `http://127.0.0.1:8888`). Unset = keyless DuckDuckGo, paced |
| `FERAL_DDG_MIN_INTERVAL_MS` | `5000` | Minimum gap between keyless DuckDuckGo queries. Raise if you see `rate_limited`; ~3s is the floor |
| `FERAL_JINA_API_KEY` | — | Jina API key for higher rate limits on `read_webpage` + `deep_research` |
| `FERAL_FETCH_DOMAINS` | — | Domain allowlist for `fetch_url`. Unset = all public hosts (SSRF guard still applies); set to RESTRICT |
| `FERAL_HTTP_DOMAINS` | — | Same as above, for the `http_request` tool |
| `FERAL_BUDGET_CONVERSATION` | `5000000` | Per-conversation token ceiling |
| `FERAL_BUDGET_DAY` | `50000000` | Per-day token ceiling |

---

## Roadmap

- [x] Chat with local models (bundled llama.cpp)
- [x] HuggingFace model browser and downloader
- [x] SkillHub — install, discover, and import agent skills
- [x] BYOK cloud keys (10+ providers)
- [x] Live hardware monitor (GPU / VRAM / RAM)
- [x] Auto-updater
- [x] Projects and conversation history
- [x] Agent mode — TypeScript sidecar with tool-use, 4-layer memory, agentic loop
- [x] Deep Research — autonomous multi-step web research with cited reports
- [x] Model fitness scoring — 4-dimension hardware compatibility score per model
- [x] Privacy tags — `<private>` blocks never written to memory
- [x] Tool health monitoring — ECC-style per-tool success rate tracking
- [x] Workspace security scanner — detect secrets and code anti-patterns
- [x] Local API server — 47 documented routes, OpenAI- and Ollama-compatible (see [docs/API.md](docs/API.md))
- [x] Sub-agents — the agent delegates self-contained tasks to parallel sub-agents (`delegate_task`)
- [x] On-device LoRA training — fine-tune a personal adapter locally, A/B-eval gated
- [ ] RAG on local documents — chat with your PDFs without sending them anywhere

---

## Security

Feral takes the "your machine, your data" promise seriously:

- Tool calls run through a **sandbox**: permission manifests, an egress proxy with SSRF protection and domain allowlists, path containment, and a full audit log
- A **workspace scanner** catches hardcoded secrets and code anti-patterns before they bite you
- Updates are **signed** (minisign) and verified before install

Found a vulnerability? Please report it responsibly — see [SECURITY.md](SECURITY.md).

## Contributing

Contributions are welcome — code, docs, bug reports, model recommendations, or just telling us what confused you.

**[→ Start here: CONTRIBUTING.md](docs/CONTRIBUTING.md)** — five minutes to a running build, plus a ladder of genuinely scoped first tasks.

You don't need the desktop app, a GPU, or a model to work on the agent:

```bash
cd FeralAgent && bun install && bun test    # 2400+ tests, ~60s
```

That's the fastest loop in the repo and where most of the interesting work is. If you want real impact, the biggest open gap is **end-to-end tests against a live provider** — the entire suite currently mocks `fetch`, and that single gap is the main limit on Feral's release maturity.

- Deep dive: [Contributor guide](docs/CONTRIBUTOR_GUIDE.md) (IPC protocols, test matrix, build & release flow)
- Open a [Discussion](https://github.com/bloom500/feral/discussions) for ideas and questions
- Check [open issues](https://github.com/bloom500/feral/issues) for something to pick up

Note that Feral is **source-available under BSL 1.1, not OSI open source** — free for individuals and small orgs, converting to Apache 2.0 four years after each release. Details in [Licence](#license) below; we'd rather you know upfront.

## License

Feral is source-available under the [Business Source License 1.1](LICENSE) (BSL).

**What that means in practice:**
- ✅ **Free forever for you** — personal use, small businesses (under $2M annual revenue), education, research, self-hosting, modifying, redistributing.
- 🚫 **Not free for big enterprise** — organizations above the revenue threshold, or anyone offering Feral as a hosted/managed service, need a [commercial license](mailto:bloommediacorporation@gmail.com).
- 🕓 **Becomes fully open source automatically** — each version converts to Apache 2.0 four years after its release.

This protects a small independent project from being repackaged by large companies while keeping it free for the people it's built for.

---

<p align="center">
  <img src="frontend-react/public/LOGO%20NO%20BG.png" alt="Feral mascot" width="64" />
</p>

<p align="center">
  <em>Built with 🖤🧡 by <a href="https://github.com/bloom500">Bloom Lab</a></em>
</p>

*Feral does not phone home, does not collect telemetry, and has never once asked you to "sign up to unlock the full experience." That would be very un-feral of it.*
