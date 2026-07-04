# Runtime Introspection — `self.*` tools

**Status:** Shipped. 12 tools + 2 skills (feral-self + feral-connectors).
**Date:** 2026-07-03
**Branch / worktree:** `D:\FeralLocalAI`
**Doc:** `docs/2026-07-03-runtime-introspection-design.md` — read first.

## What's there for the agent

Twelve `self_*` tools in `FeralAgent/src/tools/builtin/self.ts`,
registered globally (no env flag, no opt-in):

- `self_describe`, `self_status`, `self_runtime`, `self_tools`,
  `self_providers`, `self_memory`, `self_connectors`, `self_genome`,
  `self_dreams`, `self_lora`, `self_health`, `self_subsystem name=<X>`

Each is read-only, internal (no `fs:read` perm, no `allowedPaths`),
audited. They read internal state files (`~/.feral/rsi/...`,
`~/.feral/memory-graph.json`, `~/.feral/connectors.json`) directly,
so the agent does **not** need `read_file` access to `~/.feral/`
(which is correctly sandboxed away — see
`projects_substrate_introspection.md`'s predecessor, the loadWorkspaceRoots
"exposure wall").

`self_subsystem` is special: it ships a hardcoded catalog of
{Purpose, Inputs, Outputs, Safety, Promotion, Rollback} docs for each
subsystem. The catalog covers `brsi`, `fms`, `lora`, `dreaming`,
`genomes`, `connectors`, `memory`, `brain_stack`, `rsi`.

## Skills (in `~/.feral/skills/`)

- **`feral-self`** — the bootstrap. Tells the agent when to use `self.*`
  vs when not to, the architecture map, the subsystem path cheat-sheet.
- **`feral-connectors`** — the user's "ConnectorManager → Connector →
  Token → Gateway → Session" architecture, in agent-friendly prose.

## Conventions going forward

- **DON'T** try to dump the substrate into the system prompt. Tokens
  are per-turn, and the prompt goes stale silently.
- **DON'T** add a `fs:read` permission to `read_file` to grant the
  agent access to `~/.feral/`. Use `self.*` tools instead.
- **WHEN** the user asks about a subsystem (BRSI / FMS / LoRA /
  Dreaming / Genomes / Connectors / Brain Stack / Memory), the agent
  should `read_skill id=feral-self` once then use the relevant
  `self_*` tools. The hint is wired into `FeralAgent/src/AGENTS.md`
  but the agent reads skills on its own terms.
- **WHEN** the agent changes a subsystem's behavior, update the
  catalog entry in `self.ts::SUBSYSTEMS`. Drift there is silent and
  bad — the agent "knows" what the catalog says, not what the code
  does.
- **WHEN** adding a new `self_*` tool, follow the shape helper +
  thin Tool pattern. Don't bypass audit. Don't take user-controlled
  paths (no `fs:read` perm, no `allowedPaths`).

## Tests

`FeralAgent/tests/self-tool.test.ts` — 24 tests. Locks the data
contracts (shape helpers round-trip, health checks, catalog
completeness) and one security regression (connectors shape never
echoes secret values).

## Open follow-ups (deliberately deferred)

- Write-side `self_*` tools (`swap_lora`, `propose_genome`,
  `reload_connectors`). Gated until a real need surfaces.
- Live "is a dream running right now?" — bus events not yet piped
  through. `self_dreams` shows past episodes only.
- ConnectorManager live status — `self_health.connectors_manager`
  is shape-only today; plumbing an actual `.reload()` probe is a
  one-file change.
