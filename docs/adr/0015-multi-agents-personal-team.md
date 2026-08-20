# ADR-0015: Multi Agents — echipă personală de agenți pe mașina user-ului

**Status:** Proposed
**Date:** 2026-08-20
**Related:** ADR-0014 (Brain Stack), RLM subsystem (`FeralAgent/src/rlm/`)

## Context

Cinderpaw are astăzi:
- **Un singur agent activ per user** (`useAgent` store, `useAgent.getState().current`).
- Agent = combinație `{ name, system_prompt, model_id, tools[] }` stocată în DB.
- Wizard onboarding creează un agent din preset (Research/Code Helper/File Organizer/Web Scraper).
- User poate switch între agenți din `FeralModelSelector` — dar doar unul e activ la un moment dat.
- RLM subsystem (`FeralAgent/src/rlm/children.ts` + `repl.ts`) permite un notebook cell să spawn `subagents` async — dar aceștia sunt EPHEMERAL per cell, no persistence, no identity.

Ce vrea user (2026-08-20):
> "Un singur user, mai mulți agenți ai LUI. Fiecare agent are identitate proprie: rol, model, memorie, skills, chiar și poză de profil. Agentașii tăi pot lucra între ei — unul scrie cod, altul face research, altul verifică. Toți trăiesc pe mașina TA."

Referință: model Hermes Bot Mode. Diferența față de ce există:
- Persistență completă per agent (nu doar config JSON, ci memorie separată, skills separate, provenance separat).
- Multiple agents active simultaneous — user poate deschide 3 tab-uri de chat, fiecare cu alt agent.
- Agent-to-agent messaging — Agent A poate delega Agent B: "hey, verify this build passes".
- Fiecare agent are o identitate vizuală (avatar/mascotă distinctă, nu doar name).

## Decision

Design în 3 layers, fiecare shippable independent.

### Layer 1 — Agent as first-class citizen (v0.4)

Astăzi `agent_id` este column pe conversation. Facem agent-ul entitate independentă cu:
- Own database schema slice: `agents` table + `agent_memory` schema-per-agent.
- Own filesystem slice: `~/.cinderpaw/agents/<agent_id>/` cu propriile skills, provenance journal, config.
- Own identity: `name`, `avatar` (path la image sau seed pentru procedurally-generated), `personality` (short bio pentru introduction).

Schema nouă:
```sql
-- Extindere existing agents table
ALTER TABLE agents ADD COLUMN avatar_path TEXT;
ALTER TABLE agents ADD COLUMN personality TEXT;
ALTER TABLE agents ADD COLUMN created_at INTEGER;
ALTER TABLE agents ADD COLUMN memory_scope TEXT NOT NULL DEFAULT 'shared';
  -- 'shared'  = agent uses same episodic/semantic tables ca chat
  -- 'private' = agent has its own tables (agent_<id>_episodic, agent_<id>_semantic)

CREATE TABLE agent_lineage (
  child_agent_id TEXT NOT NULL,
  parent_agent_id TEXT NOT NULL,      -- forked from
  branched_at INTEGER NOT NULL,
  PRIMARY KEY (child_agent_id, parent_agent_id)
);
```

Filesystem:
```
~/.cinderpaw/
├── agents/
│   ├── ag_abc123/
│   │   ├── config.json          # {name, system_prompt, avatar_path, ...}
│   │   ├── skills/               # skills scoped to this agent only
│   │   ├── memory.sqlite         # opt-in private memory (memory_scope='private')
│   │   └── journal.jsonl         # what this agent did
│   └── ag_def456/
│       └── ...
```

UI nou:
- **Sidebar section** — "Your Team" cu list of agents, avatar mic + name + status dot (idle/busy).
- **Agent profile page** (`/agents/:id`) — vezi personality bio, skills, memory stats, tool usage, cost consumed.
- **Fork button** — "make a variant" = copy agent config + optional memory copy + new UUID.
- **Cross-chat switch** — top of every chat, dropdown to change agent (existing FeralModelSelector expanded).

Agent avatar:
- Option A: user upload image.
- Option B: procedurally generated pixel-art (reuse mascot renderer!) cu seed = agent_id hash. Fiecare agent ajunge cu mascotă unică — Cinderpaw sprite cu palette shifted per seed.

Recomandare: default Option B (auto-generated pixel companion), opt-in Option A.

### Layer 2 — Multiple concurrent active agents (v0.5)

Astăzi `useAgent.current` e single. Extindem:
```ts
// frontend-react/src/stores/agent.ts (refactor)
interface AgentState {
  list: Agent[];
  // Multiple active — keyed by chat session.
  activeBySession: Record<string, string>;  // sessionId → agentId
}
```

Un user poate opera:
- Chat tab 1 cu Agent "Code Helper"
- Chat tab 2 cu Agent "Research"
- Chat tab 3 cu Agent "Draft Writer"

Toate 3 run concurrent, fiecare cu propriile:
- Streaming inference (potentially different models via Brain Stack).
- Tool call budget separat.
- Cost tracking separat.

Sidecar (`CinderpawAgent`) must support:
- Multiple `AgentLoop` instances concurrent, indexed by `(sessionId, agentId)`.
- Session lock scoped per session (already true — `#sessionLocks` map).
- Memory scope enforcement — dacă agent are `memory_scope='private'`, all reads/writes redirected la agent_<id>_episodic (via helper `resolveMemoryScope(agentId)`).

Constraint: OS resource limit — RAM. Un local GGUF loaded per agent NU-i sustenabil (fiecare Qwen 7B = 5GB RAM). Solution:
- Agents share MODEL POOL. Dacă agent A folosește gpt-4o cloud + agent B folosește gpt-4o cloud, one shared HTTP client, separate context per agent.
- Local models: single loaded model at a time, agents queue. First-come-first-served, cu preempt after N tokens.

UI live indicator: bar sus arată "3 agents active: Code Helper (streaming), Research (idle), Draft Writer (calling tool: web_search)".

### Layer 3 — Agent-to-agent messaging (v0.6)

Agents pot delega către alți agents din team. Reuse RLM infrastructure existentă (`ChildRegistry`) dar cu persistence + identity:

```ts
// FeralAgent/src/tools/builtin/delegate-agent.ts (nou)
export const delegateAgent: Tool = {
  manifest: {
    name: 'delegate_to_agent',
    description: 'Ask another agent from the user\'s team to handle a subtask.',
    parameters: {
      agent_name: { type: 'string', description: 'Name of another agent (e.g. "Code Helper")' },
      task: { type: 'string', description: 'Self-contained task description' },
    },
    permissions: ['delegation'],
  },
  execute: async ({ agent_name, task }, ctx) => {
    // Look up agent in user's team.
    const team = await listUserAgents(ctx.sessionId);
    const target = team.find(a => a.name === agent_name);
    if (!target) return { ok: false, error: `no agent named ${agent_name}` };
    
    // Spawn delegated run — new session under target agent's identity.
    // Uses ChildRegistry pattern but PERSISTED (agent_delegations table).
    const delegationId = await spawnDelegation({
      fromAgentId: ctx.agentId,
      toAgentId: target.id,
      task,
      parentSessionId: ctx.sessionId,
    });
    
    // Return handle immediately — parent continues, checks later.
    return { 
      ok: true, 
      content: `Delegated to ${agent_name} (delegation ${delegationId})`,
      data: { delegationId, agentName: target.name },
    };
  },
};
```

Complement:
- `check_delegations` tool — parent verifică status delegations în flight sau completed.
- UI shows delegation graph în chat: "Code Helper asked Research to look up... Research replied ..."

Schema nouă:
```sql
CREATE TABLE agent_delegations (
  id TEXT PRIMARY KEY,
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT NOT NULL,
  parent_session_id TEXT NOT NULL,
  child_session_id TEXT NOT NULL,
  task TEXT NOT NULL,
  status TEXT NOT NULL,      -- 'running' | 'completed' | 'failed'
  answer TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
```

Security constraint: delegation stays WITHIN user's team. Agent A poate delega doar la agent B din același `~/.cinderpaw/agents/`. No cross-user delegation aici (asta ține de ADR-0016 Community).

Cost accounting: delegated agent's cost bill-uită la user, dar attributed la parent turn pentru transparency.

## Consequences

**Positive:**
- Cinderpaw devine "your team of AIs" nu "your AI assistant" — poziționare distinctă.
- Multiple concurrent chats = productivity boost real.
- Agent-to-agent = compose complex workflows fără orchestrare manuală user.
- Mascot per agent (auto-gen pixel) = branding continuity + emotional attachment.

**Negative:**
- Multiple concurrent agents pot exhaust local RAM sau cloud budget rapid.
- Delegation graph complex → debugging harder când Agent A delegs la B who delegs la C.
- Agents cu shared memory scope pot leak context între ele (user asks Research about private info, later Code Helper accidentally knows about it).

**Migration path v0.4:**
- Schema extension additive, existing agents get default `memory_scope='shared'`, `avatar_path=NULL` (renders default).
- No breaking change pentru single-agent users — sidebar "Your Team" arată doar dacă >1 agent creat.

**Risks / open questions:**
- Skills scoping — un skill învățat de Agent A să fie disponibil pentru B? Default YES (shared skills library), opt-in NO per agent.
- Cost pooling — agents share user's BYOK keys sau fiecare are propria "wallet"? Recomand shared with opt-in split.
- Cross-agent memory search — user vrea "search all my agents' memory for X"? Yes, dar cu privacy flag per agent (`memory_searchable=false` opt-out).
- Deletion — delete agent = delete propria memorie, dar delegation history rămâne (audit).

## References

- Existing: `frontend-react/src/stores/agent.ts`, `FeralAgent/src/rlm/children.ts`
- Related: ADR-0014 (Brain Stack), ADR-0016 (Community — succesor logic)
- Inspiration: Hermes Bot Mode (per user description)
