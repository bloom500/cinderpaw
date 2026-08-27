# Feral Agent

A proactive, portable AI agent with a **native security sandbox**, built in
TypeScript on [Bun](https://bun.sh). Agent layer for the Feral desktop app
(Rust + Tauri v2 + Leptos) — runs the same core on any transport via an
adapter pattern.

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| [Bun](https://bun.sh) | ≥ 1.1 | `curl -fsSL https://bun.sh/install \| bash` |
| [Ollama](https://ollama.com) | any | [ollama.com/download](https://ollama.com/download) |
| [Git](https://git-scm.com) | any | pre-installed on most systems |

Ollama is required only for the live agent loop. All tests and the sandbox run
without it.

---

## Quick start

```bash
git clone https://github.com/bloom500/cinderpaw-agent.git
cd feral-agent
bun install
```

Pull the default model (first time only, ~4 GB):

```bash
ollama pull qwen2.5:7b
```

Start Ollama in the background (if not already running):

```bash
ollama serve
```

Run the agent (waits for newline-delimited JSON on stdin):

```bash
bun run src/index.ts
```

---

## Testing locally

### 1. Run the test suite (no Ollama needed)

The full suite — sandbox guarantees, inference router, memory, mood, and the
end-to-end integration test — runs with mocked network, no LLM required:

```bash
bun test
# → 53 pass, 0 fail
```

Typecheck only:

```bash
bunx tsc --noEmit
```

### 2. Smoke test without Ollama (sandbox + transport only)

Verify the agent boots, responds to `ping`, and handles a message gracefully
when Ollama is not reachable:

**PowerShell (Windows):**
```powershell
@'
{"type":"ping"}
{"type":"message","id":"m1","content":"hello","sessionId":"test"}
{"type":"shutdown"}
'@ | CINDERPAW_DB=":memory:" bun run src/index.ts
```

**Bash / Git Bash:**
```bash
printf '{"type":"ping"}\n{"type":"message","id":"m1","content":"hello","sessionId":"test"}\n{"type":"shutdown"}\n' \
  | CINDERPAW_DB=":memory:" bun run src/index.ts
```

Expected output (no Ollama running):
```json
{"type":"pong"}
{"type":"error","id":"m1","message":"Inference unavailable: primary inference failed ..."}
```

### 3. Full conversation with Ollama running

Start Ollama (`ollama serve`), then:

**PowerShell:**
```powershell
@'
{"type":"ping"}
{"type":"message","id":"1","content":"Ce poti face?","sessionId":"sess1"}
{"type":"message","id":"2","content":"Cauta pe web: Bun runtime","sessionId":"sess1"}
{"type":"shutdown"}
'@ | bun run src/index.ts
```

**Bash:**
```bash
printf '%s\n' \
  '{"type":"ping"}' \
  '{"type":"message","id":"1","content":"What can you do?","sessionId":"sess1"}' \
  '{"type":"message","id":"2","content":"Search the web: Bun runtime","sessionId":"sess1"}' \
  '{"type":"shutdown"}' \
  | bun run src/index.ts
```

Expected: `pong`, then streaming `chunk` → `done` events. Web search triggers
`tool_start` / `tool_done` events before the final answer.

### 4. Inspect the audit log

Every action is written to SQLite. After a session:

```bash
# Open the DB (requires sqlite3 CLI)
sqlite3 data/feral.db "SELECT timestamp, action_type, tool_name, result FROM audit_log ORDER BY id;"
```

### 5. Build the Tauri sidecar binary

```bash
bun run build
# → dist/feral-agent (single executable, no Node/Bun needed at runtime)
```

---

## Configuration

Set via environment variables (or a `.env` file — Bun reads it automatically):

| Variable | Default | Purpose |
|---|---|---|
| `CINDERPAW_DB` | `data/feral.db` | SQLite path (`:memory:` for ephemeral) |
| `CINDERPAW_WORKSPACE` | cwd | root directory `read_file` may access |
| `CINDERPAW_MODEL` | `qwen2.5:7b` | primary model name |
| `CINDERPAW_BASE_URL` | `http://localhost:11434` | primary inference endpoint |
| `CINDERPAW_PROVIDER` | `ollama` | `ollama` or any OpenAI-compatible API |
| `CINDERPAW_FALLBACK_MODEL` | — | enables a fallback target when set |
| `CINDERPAW_FALLBACK_BASE_URL` | `http://localhost:11434` | fallback endpoint |
| `CINDERPAW_TRUSTED_BASE_URLS` | configured targets | comma-separated inference allowlist |
| `CINDERPAW_BUDGET_CONVERSATION` | `50000` | per-conversation token cap |
| `CINDERPAW_BUDGET_DAY` | `500000` | per-day token cap |
| `CINDERPAW_BUDGET_POLICY` | `compress_and_continue` | or `stop` |
| `CINDERPAW_FETCH_DOMAINS` | — | comma-separated domain allowlist for `fetch_url` (e.g. `example.com,api.github.com`) |
| `CINDERPAW_INNER_THOUGHTS_ENABLED` | `false` | `true` to enable proactive loop (V2) |
| `CINDERPAW_THOUGHTS_INTERVAL_MS` | `300000` | inner-thoughts tick interval |

Example `.env` for development:

```env
CINDERPAW_DB=data/dev.db
CINDERPAW_MODEL=qwen2.5:7b
CINDERPAW_BASE_URL=http://localhost:11434
CINDERPAW_WORKSPACE=/Users/you/projects
CINDERPAW_BUDGET_CONVERSATION=100000
```

---

## Architecture (4 layers)

```
src/
├── core/
│   ├── agent-loop.ts       Layer 1 — prompt → infer → tools → loop
│   ├── mood.ts             Layer 1 — in-memory emotional state (4 dimensions)
│   └── inner-thoughts.ts   Layer 1 — proactive background loop (V2, flagged off)
├── memory/
│   ├── working.ts          Layer 2 — in-session transcript, auto-compresses
│   ├── episodic.ts         Layer 2 — FTS5 searchable event history
│   ├── semantic.ts         Layer 2 — persistent key-value user model
│   └── recall.ts           Layer 2 — unified retrieval injected before inference
├── sandbox/                Layer 3 — SECURITY (constructed before everything else)
│   ├── audit-log.ts        every action → SQLite audit_log row
│   ├── tool-permissions.ts manifest validation + path containment
│   ├── egress-proxy.ts     feralFetch(): domain whitelist, SSRF guard, rate limit
│   └── inference-router.ts single LLM choke point: budgets, allowlist, fallback
├── transports/             Layer 4 — transport-agnostic core
│   ├── interface.ts        Transport contract
│   ├── tauri.ts            stdin/stdout newline-delimited JSON (V1, active)
│   ├── telegram.ts         V2 stub
│   └── whatsapp.ts         V2 stub
├── tools/
│   ├── registry.ts         single gate for every tool call
│   └── builtin/
│       ├── read-file.ts    fs:read, allowedPaths enforced
│       └── web-search.ts   network:outbound, DuckDuckGo, no API key
├── db.ts                   bun:sqlite — schema, migrations, WAL mode
├── types.ts                shared interfaces (no runtime code)
└── index.ts                wires all layers, starts transport
```

### Security guarantees (enforced, not optional)

- Every tool must declare a manifest before registration; undeclared permissions
  are blocked at call time and written to the audit log.
- No network request reaches the wire without passing through `feralFetch()` —
  loopback, private, and link-local ranges are blocked (SSRF guard), domains are
  whitelisted per-tool, and a rolling-window rate limit applies.
- Every LLM call goes through the inference router — per-conversation and per-day
  token budgets enforced, inference endpoints validated against a trusted allowlist
  (port-normalized, checked at construction and at call time).
- Every action — tool call, inference, network request, memory write, or blocked
  attempt — produces an `audit_log` row. The logger never throws to callers;
  an audit failure is reported to stderr but does not crash the agent.

---

## IPC protocol (Tauri sidecar)

Newline-delimited JSON over stdin/stdout. stdout is reserved for protocol
traffic only — all diagnostics go to stderr.

**Inbound (stdin → agent):**
```json
{ "type": "message", "id": "uuid", "content": "user text", "sessionId": "sess_1" }
{ "type": "ping" }
{ "type": "shutdown" }
```

**Outbound (agent → stdout):**
```json
{ "type": "chunk",      "id": "uuid", "content": "partial response" }
{ "type": "done",       "id": "uuid", "content": "full response" }
{ "type": "tool_start", "tool": "web_search", "args": { "query": "..." } }
{ "type": "tool_done",  "tool": "web_search", "result": { ... } }
{ "type": "proactive",  "content": "agent-initiated message" }
{ "type": "pong" }
{ "type": "error",      "id": "uuid", "message": "..." }
```

---

## Roadmap

### V1 — done ✓

- [x] Sandbox: audit log, egress proxy (SSRF + whitelist), tool-permission
      manifests, inference router with token budgets and trusted-endpoint allowlist
- [x] Memory: working (auto-compress), episodic (FTS5), semantic (key-value
      user model), recall (injected before every inference turn)
- [x] Agent loop: prompt → LLM → tool calls → sandbox enforce → loop
- [x] Tauri transport: stdin/stdout newline-delimited JSON, drain-on-exit
- [x] Built-in tools: `read_file` (fs:read), `web_search` (DuckDuckGo)
- [x] 53 tests — sandbox, inference router, memory, mood, full pipeline

### V2 — next

- [ ] **Inner thoughts** — enable the proactive loop; add mood decay +
      `shouldBeProactive()` gate (code exists, flagged off with
      `CINDERPAW_INNER_THOUGHTS_ENABLED=true`)
- [ ] **Vector search** — `sqlite-vec` for semantic similarity in recall
      (schema-compatible slot already in `semantic.ts`)
- [ ] **Additional transports** — Telegram, WhatsApp (stubs exist in
      `src/transports/`)
- [ ] **Iteration engine** — `src/core/iteration.ts`, auto-iterate complex
      multi-step tasks with token budget management
- [ ] **Cloud inference + credential broker** — host holds API keys, sandbox
      gets short-lived tokens (pattern from NemoClaw reference)
- [ ] **Per-path access modes** — read vs write per `allowedPaths` entry
      (currently flat list, pattern from openclaw reference)
- [ ] **DNS rebind protection** — resolve-then-pin for cloud inference
      endpoints (V1 note: safe for local Ollama, needed before cloud)
- [ ] **Real tokenizer** — replace `length/4` estimate with tiktoken or
      provider tokenizer for accurate budget tracking on non-English text
