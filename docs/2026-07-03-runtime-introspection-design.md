# Runtime Introspection — `self.*` tools

**Date:** 2026-07-03
**Status:** Shipped in `FeralAgent/src/tools/builtin/self.ts` + 2 skills.
**Predecessor:** 2026-07-03 TUI work (which established the `chat_ui.rs`
discipline of separating widget models from rendering); this work
applies the same separation to the agent's self-model.

## Problem

Until today the agent could answer questions about its own state only by
either (a) hallucinating or (b) carrying ~4k tokens of "Available skills
menu" + system-prompt boilerplate describing every subsystem. Both were
bad. The user (Darius) framed it sharpest:

> *"Dacă agentul nu știe că ConnectorManager → DiscordConnector → Token
> → Gateway → Session există, atunci nici n-o să se gândească să le
> folosească. Va trata totul ca pe un chatbot."*

> *"Feral ar putea avea echivalente interne: self.status, self.memory,
> self.tools, self.runtime, self.providers, self.connectors, self.genome,
> self.dreams, self.lora, self.health."*

> *"Asta scalează mult mai bine pe măsură ce Feral crește și îi dă
> senzația că este cu adevărat conștient de propriul ecosistem, nu doar
> un LLM cu multe funcționalități ascunse în spate."*

## Design

### Two-tier namespace

**`self.*` tools (shell-style, narrow, fast):**

| Tool             | Returns                                               |
| ---------------- | ------------------------------------------------------ |
| `self_describe`  | Full runtime identity document (one big JSON)         |
| `self_status`    | One-line heartbeat per subsystem                       |
| `self_runtime`   | Version, boot time, model, base URL                    |
| `self_tools`     | Available tool table (with `query` filter)             |
| `self_providers` | Inference primary + fallback + brain-stack hint       |
| `self_memory`    | Fractal Memory stats + knowledge-graph presence        |
| `self_connectors`| Configured connectors (no secrets)                    |
| `self_genome`    | BRSI population summary                                |
| `self_dreams`    | Dream-cycle last episode(s)                            |
| `self_lora`      | LoRA registry + per-domain champion                   |
| `self_health`    | Diagnostic: which subsystems are present               |
| `self_subsystem` | Deep dive on one subsystem (purpose, inputs, outputs, safety, promotion, rollback) |

Two tiers because:

- The **narrow tools** are `O(1)` reads of small files — sub-millisecond,
  perfect for "how is X doing?" questions.
- The **`self_subsystem` deep dives** are hardcoded maps (no I/O) — the
  shape rarely changes, and a runtime-rendered version would just hide
  the same knowledge one layer deeper.

### Per-subsystem shape (purpose / inputs / outputs / safety / promotion / rollback)

The catalog answers "how does it work" for each subsystem, not "do I
have it". This is the user's second design point:

> *"Dream Cycle: Purpose / Inputs / Outputs / Safety / Promotion /
> Rollback. La fel pentru BRSI / LoRA / FMS / Genome / Memory /
> Connectors / Brain Stack."*

The catalog covers: `brsi`, `fms`, `lora`, `dreaming`, `genomes`,
`connectors`, `memory`, `brain_stack`, `rsi` — see
`FeralAgent/src/tools/builtin/self.ts:135-466`.

### Skills

Two SKILL.md files dropped at `~/.feral/skills/<id>/SKILL.md`:

- **`feral-self`** — the bootstrap. Teaches the agent when to use
  `self.*` (and when not to), the architecture diagram, the subsystem
  map, the path cheat-sheet, and the failure modes. **The agent loads
  this on first substrate question and forgets the details.**
- **`feral-connectors`** — deep dive on the Discord / Slack /
  WhatsApp wires. The user's exact framing ("ConnectorManager →
  Connector → Token → Gateway → Session") is enshrined here. Used for
  "connect yourself to X" tasks.

A subtle note added to `FeralAgent/src/AGENTS.md` under "Skills" tells
the agent to load `feral-self` when substrate questions come up. This
is the only nudge needed; the dynamic skill menu already advertises
the skill id.

### Why a tool, not a system-prompt bump

The user explicitly rejected the "dump it in the prompt" approach:

> *"Asta e mult mai bun decât un system prompt de 4.000 de tokeni."*

The technical case: the agent already pays for ~700 tokens of system
prompt every turn (SOUL + IDENTITY + AGENTS + tool drawer). Adding 3-4k
more for substrate docs is cost-per-turn, not cost-per-question. With
`self.*` tools, the doc is loaded only when the user actually asks.

The epistemic case: documentation the agent can read IS the interface.
A 4k-token block in the system prompt is text the LLM "knows" but
cannot verify against the live runtime — it goes stale silently. The
`self.*` tools read live state, so a `champion.json` change is
immediately visible to the next `self_genome` call. Drift is gone.

## What "real" gives the agent now

Before this work, the agent's view of itself was:

> *"I am Feral. I can read files, run shells, search the web, do math,
> talk to humans. I think. I am warm."*

After:

> *"I am Feral. I run version X.Y.Z. I am running on
> ollama/Qwen2.5-3B at http://127.0.0.1:11435. Brain Stack is on/off.
> My BRSI champion is g-42 at score 0.91. My LoRA registry holds 4
> adapters; the active one is at /path/to/coding.gguf. I have 1,247
> leaves in FMS, 1 knowledge graph with N nodes. Discord is configured
> but paused. No dream episodes recorded. I have these 30 tools:
> read_file, grep, …, self_describe, self_status, self_connectors, …
> I am one of: agent loop | gateway | BRSI · Dreaming."*

That delta — from "what I was told" to "what I can verify" — is the
introspection slice.

## Verification

### Bun tests + tsc

- `bunx tsc --noEmit` clean.
- `bun test` green (1912 pass, 5 pre-existing skip, 0 fail).
- New: `tests/self-tool.test.ts` — 24 tests covering shape helpers,
  health checks, subsystem catalog completeness, and a security
  regression test (`shapeConnectors never echoes secret values`).

### Manual

```bash
cd FeralAgent
bun test tests/self-tool.test.ts    # passes
```

In a live session, the operator can verify by:

```text
> Read the feral-self skill.
list_skills  →  read_skill id=feral-self

> What can you do?
self_describe

> How is BRSI doing?
self_status

> What's the LoRA registry?
self_lora

> What's the connector architecture?
read_skill id=feral-connectors  →  self_subsystem name=connectors

> Are you dreaming?
self_dreams
```

Expected: each call returns shaped JSON the agent can quote verbatim
to the user.

## Constraints honored

- **Stay inside `FeralAgent/`** (the user said "FeralAgent" was the
  natural home for tooling).
- **No new system-prompt tokens** — every byte of introspection is
  opt-in via a tool call.
- **Existing `recall` shape unchanged** — `self.*` are additive.
- **Pre-existing connectors / audit / tool_health unchanged** —
  `self_connectors` reads `connectors.json` directly; `self_health`
  builds on top of the existing surface, doesn't replicate it.
- **No filesystem permissions** — all reads are from internal
  TypeScript modules; the audit log records every call regardless.

## What's still missing (for Opus / a follow-up)

The work is minimum-viable in two deliberate senses:

1. **No write tools** — `self.*` is read-only. A future slice can add
   `self_swap_lora`, `self_propose_genome`, `self_reload_connectors`
   if a clear need arises (and probably gated behind a new env flag).
2. **No live Goal Dream status** — `self_dreams` shows past episodes
   but not whether a dream is currently running. The broadcast bus
   has the live events; plumbing them through is a small follow-up.
3. **Subsystem catalog is hand-maintained** — drift between catalog
   text and reality is possible. A test asserts shape but not
   content freshness; the next agent who changes a subsystem should
   update `SUBSYSTEMS` (the file is small and well-commented).

The skills + tools are enough for the user's stated goal: an agent
that knows what it has.
