<p align="center">
  <img src="frontend-react/public/README%20banner.jpeg" alt="Feral — your local-first AI workspace" width="100%" />
</p>

# Feral

**Your local-first AI workspace. No subscription. No telemetry. No middleman.**

<p align="center">
  <a href="https://github.com/bloom500/feral/releases/latest"><img src="https://img.shields.io/github/v/release/bloom500/feral?style=for-the-badge&color=blue&label=version" alt="Version" /></a>
  <img src="https://img.shields.io/badge/license-MIT%20%2B%20Apache--2.0-green?style=for-the-badge" alt="License" />
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

## What's new in v0.2.0

- 🖼️ **Vision** — paste or drop screenshots and image files; the model sees real pixels, not filenames (BYOK cloud + agent sidecar)
- 🧠 **Memory that carries over** — a shared knowledge graph feeds every new conversation, and "remember X" / "forget Y" work instantly
- 🕸️ **Memory Graph page** — explore everything Feral knows about you in a glowing, filterable graph visualization
- 🔌 **MCP Extensions** — app-store style page for Model Context Protocol servers: one-click install, on/off toggles, zero config files
- 👹 **The real Feral mascot** — the pixel companion is now the brand monster itself (black fur, orange horns, orange belly): 50+ animated variants across 22 states, plus per-state particle effects, at a bigger, crisper size
- 🗣️ **Friendlier agent voice** — rewritten SOUL.md, user-overridable identity files
- 📎 **Attach any file** — drag & drop or paste anything into the chat: PDFs and Office docs are parsed natively, text files of any extension just work, and binaries reach the agent as a path it can open with its tools
- 🍎🐧 **macOS & Linux** — installers for macOS (Apple Silicon + Intel) and Linux (.deb/.rpm) now ship alongside Windows, faster startup, stop button that actually stops, and a pile of stability fixes

Full details in the [CHANGELOG](CHANGELOG.md). Upgrading from **0.1.7 or older**? Read the [updater key migration notes](docs/UPDATER_KEY_MIGRATION.md) first.

---

## Install

Grab the latest installer from [Releases](https://github.com/bloom500/feral/releases/latest). No admin rights required. The built-in updater keeps you current after that.

| Platform | Installer | Status |
|---|---|---|
| **Windows 10/11** (x64) | `.msi` / `.exe` | 🟢 Stable — primary target |
| **macOS** (Apple Silicon, Intel) | `.dmg` | 🟡 Beta — CI-built, lightly tested on real hardware. [Report issues](https://github.com/bloom500/feral/issues). |
| **Linux** (Ubuntu/Debian) | `.deb` / `.rpm` | 🟡 Beta — CI-built, lightly tested. [Report issues](https://github.com/bloom500/feral/issues). |

> **macOS first launch:** Feral isn't notarized by Apple (yet), so macOS will warn you on first open. If you see *"Feral.app is damaged"* or *"can't be opened"*, run this once in Terminal and you're set:
> ```bash
> xattr -cr /Applications/Feral.app
> ```
> Then open Feral normally. This removes the quarantine flag macOS puts on downloaded apps — nothing is actually damaged.

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

| Local models, scored for your hardware | Browse HuggingFace in-app | Bring your own keys |
|---|---|---|
| ![Local models](frontend-react/public/READMEdemo2.png) | ![Browse HuggingFace](frontend-react/public/READMEdemo3.png) | ![Cloud keys](frontend-react/public/READMEdemo5.png) |

## Privacy, honestly

- **Local models:** inference, conversations, and memory never leave your machine. No background network requests, no telemetry, no analytics — by design.
- **Cloud models (BYOK):** your messages go to the provider you configured (OpenAI, Anthropic, …) when — and only when — you hit send. Feral talks to their API directly with your key; nothing is routed through our servers, because we don't have any. Their privacy policy applies to what you send them.
- **Web tools:** agent tools like `web_search` and `deep_research` make outbound requests (DuckDuckGo, Jina) when the agent uses them — through an egress proxy with domain allowlists and an audit log.

| | |
|---|---|
| ![Privacy settings](frontend-react/public/READMEdemo7.png) | ![General settings](frontend-react/public/READMEdemo4.png) |

---

## What's inside

| Feature | Description |
|---|---|
| **Chat** | Persistent conversations with any local or cloud model. Projects keep related chats grouped and sane. |
| **Agent Mode** | A full TypeScript sidecar agent with tool-use, 4-layer memory, and an agentic loop. It thinks. Sometimes too much. |
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

- **Manifest validation** — tools declare `permissions: ["fs:read" | "fs:write" | "network:outbound" | "process:spawn"]` at registration; undeclared permissions are blocked
- **Egress proxy** — all network requests go through `ctx.fetch()` (never raw `fetch()`), which enforces per-tool domain allowlists, blocks SSRF (loopback / private / link-local ranges), rate-limits (30 req/60s), and audits every call
- **Path containment** — filesystem tools resolve paths against declared `allowedPaths`; directory traversal (`../`) is blocked before any disk access
- **Audit log** — every tool call, network request, and inference call is written to SQLite

### Built-in tools

| Tool | Permissions | Description |
|---|---|---|
| `web_search` | `network:outbound` | DuckDuckGo search. No API key required. |
| `read_webpage` | `network:outbound` | Extracts clean Markdown from any URL via Jina Reader (`r.jina.ai`). No API key required. |
| `deep_research` | `network:outbound` | DeepResearch-style iterative loop: plan → search (Jina Search) → select URLs → read pages → extract findings → repeat → synthesize cited Markdown report. 4–8 iterations. |
| `read_file` | `fs:read` | Read files from the workspace. 64 KB cap. |
| `write_file` | `fs:write` | Write files to the workspace. 1 MB cap. Creates intermediate directories. |
| `list_directory` | `fs:read` | List directory contents. 200 entries max. |
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
| Web research | Jina Search + Jina Reader (no API key required) |
| Model discovery | HuggingFace Hub API |
| Signing & updates | tauri-plugin-updater + minisign |

---

## Environment variables (Agent sidecar)

When launched by the desktop app, the sidecar is pointed at Feral's **own bundled llama.cpp engine** (the loopback API on port 11435, with the per-launch bearer token injected automatically) — **no Ollama required**. The `FERAL_PROVIDER` / `FERAL_BASE_URL` defaults below apply only when running the sidecar standalone.

| Variable | Default | Description |
|---|---|---|
| `FERAL_DB` | `data/feral.db` | SQLite path (`:memory:` for ephemeral) |
| `FERAL_WORKSPACE` | cwd | Root for filesystem tools |
| `FERAL_MODEL` | `qwen2.5:7b` | Model name (overridden to `feral-local` by the app) |
| `FERAL_BASE_URL` | `http://localhost:11434` | Inference endpoint (app injects `http://127.0.0.1:11435`) |
| `FERAL_PROVIDER` | `ollama` | Provider (`ollama` or `openai_compatible`; app injects `openai_compatible`) |
| `FERAL_API_KEY` | — | Bearer token for the inference endpoint (app injects the local API token) |
| `FERAL_ENABLE_SHELL_EXEC` | `false` | Register the generic `shell_exec` tool (argv-only, no shell). Off by default. |
| `FERAL_SHELL_WHITELIST` | `git,node,python,…` | Comma-separated binaries `shell_exec` may run |
| `FERAL_TOOL_GRAMMAR` | `false` | Grammar-constrain tool calls on the bundled engine (lazy GBNF) |
| `FERAL_JINA_API_KEY` | — | Jina API key for higher rate limits on search + reader |
| `FERAL_FETCH_DOMAINS` | — | Comma-separated domain allowlist for `fetch_url` tool |
| `FERAL_BUDGET_CONVERSATION` | `50000` | Max tokens per conversation |
| `FERAL_BUDGET_DAY` | `500000` | Max tokens per day |

---

## Roadmap

- [x] Chat with local models (Ollama / llama.cpp)
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
- [ ] Local API server — expose a local endpoint for other apps to consume
- [ ] RAG on local documents — chat with your PDFs without sending them anywhere
- [ ] Multi-agent workflows — skills that spawn sub-agents and coordinate results

---

## Security

Feral takes the "your machine, your data" promise seriously:

- Tool calls run through a **sandbox**: permission manifests, an egress proxy with SSRF protection and domain allowlists, path containment, and a full audit log
- A **workspace scanner** catches hardcoded secrets and code anti-patterns before they bite you
- Updates are **signed** (minisign) and verified before install

Found a vulnerability? Please report it responsibly — see [SECURITY.md](SECURITY.md).

## Contributing

Contributions are welcome — code, docs, bug reports, model recommendations, or just telling us what confused you.

- Start with the [Contributing guide](docs/CONTRIBUTING.md) and the [Contributor guide](docs/CONTRIBUTOR_GUIDE.md) (architecture, IPC protocols, test matrix, build & release flow)
- Open a [Discussion](https://github.com/bloom500/feral/discussions) for ideas and questions
- Check [open issues](https://github.com/bloom500/feral/issues) for something to pick up

## License

MIT + Apache 2.0 — see the repository for details.

---

<p align="center">
  <img src="frontend-react/public/LOGO%20NO%20BG.png" alt="Feral mascot" width="64" />
</p>

<p align="center">
  <em>Built with 🦁 by <a href="https://github.com/bloom500">Bloom Lab</a></em>
</p>

*Feral does not phone home, does not collect telemetry, and has never once asked you to "sign up to unlock the full experience." That would be very un-feral of it.*
