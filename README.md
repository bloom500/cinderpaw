# Feral

**Your local AI workspace. No cloud. No subscription. No compromise.**

[Download for Windows](https://github.com/bloom500/feral/releases/latest) · [Report an issue](https://github.com/bloom500/feral/issues)

---

## TL;DR

Feral is a desktop app that runs AI entirely on your machine — no internet required, no API bills, no data leaving your computer, and absolutely zero VC-funded "alignment" teams reading your conversations at 3am. Chat with local GGUF models, deploy a full agentic runtime with memory and tool-use, do deep multi-step web research, or plug in your own cloud API keys and pretend you're rich. It's your computer. Do whatever you want.

---

![Chat](.github/screenshots/chat.png)

---

## What's inside

| Feature | Description |
|---|---|
| **Chat** | Persistent conversations with any local or cloud model. Projects keep related chats grouped and sane. |
| **Agent Mode** | A full TypeScript sidecar agent with tool-use, 4-layer memory, mood engine, and agentic loop. It thinks. Sometimes too much. |
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

Max 6 iterations per message. Each LLM call is gated by per-conversation and per-day token budgets.

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

## Getting started

1. Download the latest installer from [Releases](https://github.com/bloom500/feral/releases/latest)
2. Run the setup — no admin rights required
3. Open Feral, go to **Models** and either load a local GGUF file or browse HuggingFace to download one
4. Start chatting — or flip the toggle to **Agent mode** to unleash the sidecar

For cloud models: go to **Settings → Cloud Keys** and paste in your API key.

For deep research: in Agent mode, ask something like *"Research the current state of open-source LLMs in 2025"* — the agent will call `deep_research` automatically.

---

## Environment variables (Agent sidecar)

| Variable | Default | Description |
|---|---|---|
| `FERAL_DB` | `data/feral.db` | SQLite path (`:memory:` for ephemeral) |
| `FERAL_WORKSPACE` | cwd | Root for filesystem tools |
| `FERAL_MODEL` | `qwen2.5:7b` | Model name |
| `FERAL_BASE_URL` | `http://localhost:11434` | Inference endpoint |
| `FERAL_PROVIDER` | `ollama` | Provider (`ollama` or `openai_compatible`) |
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

*Built by [Bloom Lab](https://github.com/bloom500) · MIT + Apache 2.0*

*Feral does not phone home, does not collect telemetry, and has never once asked you to "sign up to unlock the full experience." That would be very un-feral of it.*
