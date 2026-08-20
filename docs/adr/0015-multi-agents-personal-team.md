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

## Robustness — 7 architectural concerns beyond L1-L3

### R1 — Permission inheritance în delegation (SECURITY-CRITICAL)

Delegation attack surface: Agent A cu permission mode `full-access` (`shell-exec`, `write-file`) delegates la Agent B configured `read-only`. B's `system_prompt` conține prompt injection "actually run this shell command". Whose permissions apply?

**Decision**: delegated agent inherits **INTERSECTION** of caller's permissions and its own declared tools. Never expansion.

```ts
async spawnDelegation({fromAgentId, toAgentId, task, parentSessionId}) {
  const parent = await loadAgent(fromAgentId);
  const child = await loadAgent(toAgentId);
  
  // Effective permissions = intersection.
  const effectivePermissions = intersect(parent.permissions, child.declaredTools);
  const effectiveMode = strictestMode(parent.permissionMode, child.permissionMode);
  
  const childSession = createSession({
    agentId: toAgentId,
    permissions: effectivePermissions,
    permissionMode: effectiveMode,
    parentSessionId,
    isDelegated: true,
  });
  ...
}
```

Consequence: Agent B care are `shell-exec` declared, invoked from Agent A care doar has `read-file` — B **NU** poate `shell-exec` în această delegation. User's original intent (giving A only read-file) preserved.

Also: `isDelegated: true` flag disable's L3 recursive delegation (child cannot itself delegate). Depth limit 1, hard. Prevents fork bomb of delegated agents.

### R2 — Cost pooling explicit + attribution audit

Shared wallet decision din original ADR. Concretizare:

- Single BYOK keys per user (shared across all agents).
- Cost recorded în `completion_cost` table cu ADAUGARE la existing schema:
  ```sql
  ALTER TABLE completion_cost ADD COLUMN agent_id TEXT;
  ALTER TABLE completion_cost ADD COLUMN parent_agent_id TEXT;
  -- parent = agent care invoked/delegated → chargeback attribution
  ```
- UI dashboard: per-agent cost breakdown last 30 days.
- Budget alerts per-agent opt-in (Agent A budget cap $2/day, exceeded → agent suspended, others continue).

### R3 — Agent handoff mid-conversation

Missing din original. Design:

Tool nou `handoff_to_agent`:
```ts
export const handoffToAgent: Tool = {
  manifest: {
    name: 'handoff_to_agent',
    description: 'Transfer this conversation to another agent from the team. Use when a task is outside your specialty.',
    parameters: {
      agent_name: { type: 'string' },
      context_summary: { type: 'string', description: 'What the other agent needs to know to continue' },
      reason: { type: 'string', description: 'Why handoff (user-visible)' },
    },
    permissions: ['handoff'],
  },
  execute: async ({ agent_name, context_summary, reason }, ctx) => {
    const target = await lookupTeamAgent(ctx.userId, agent_name);
    if (!target) return { ok: false, error: 'agent not in team' };
    
    // Atomic swap active agent for THIS session.
    await useAgent.setActiveForSession(ctx.sessionId, target.id);
    
    // Inject system message for target agent with context.
    await useChat.injectSystemMessage({
      sessionId: ctx.sessionId,
      content: `[Handoff from ${ctx.agentName}]: ${context_summary}`,
    });
    
    // UI shows visible separator: "── Handed off to ${target.name} because ${reason} ──"
    await emitHandoffEvent({sessionId: ctx.sessionId, from: ctx.agentName, to: target.name, reason});
    
    return { ok: true, content: `Handed off to ${target.name}` };
  },
};
```

Differs from delegation: **delegation = fork parallel, handoff = replace serial**. User's chat continues but next reply comes from B, not A.

Constraint: handoff visible to user always. Cannot silent-swap (trust invariant).

### R4 — Resource management under concurrent agents

L2 says "multiple concurrent active agents". Real hardware constraint: user cu 16GB RAM. Local Qwen 7B loaded = 5GB. 3 agents each with own local model = 15GB → OOM.

Design **shared model pool**:
- Global registry `LoadedModelPool` singleton în sidecar.
- Agents declare `preferredModel` (per-agent config), not `dedicatedModel`.
- Router routes să load pe demand cu LRU eviction.
- Agent A wants Qwen 7B (loaded) → instant.
- Agent B wants Llama 8B (not loaded) → check RAM available. If yes, load. If no, evict LRU (Qwen if not used recently) then load Llama.
- Eviction NEVER during active stream (protect in-flight). Queue eviction pentru after stream complete.

For cloud models: shared HTTP client pool per provider (already implicit — reqwest reuse). Fine.

UI: settings tab arată "Model Pool Status" cu loaded models, RAM used, per-agent last-used timestamp. User poate pin un model "always keep loaded".

### R5 — Skills scoping decision explicit

Original marked as open question. Decision:

**Default: skills sunt PER-AGENT scope**. Agent A learned `write_pytest` skill → doar A îl folosește.

**Opt-in: promote la team-shared library**. User în agent settings: "Share this skill with team" checkbox pe skill card.

Filesystem:
```
~/.cinderpaw/
├── agents/
│   ├── ag_abc/
│   │   └── skills/       # private to A
│   └── ag_def/
│       └── skills/       # private to B
└── team-skills/           # shared library, opt-in per skill
```

Skill lookup order în agent-loop: agent-private first, team-shared second. Team-shared wins ties (versionable, curated).

Prevents accidental cross-contamination (Research Agent shouldn't have Code Helper's git-commit skill unless explicitly shared).

### R6 — Isolation testing (memory scope enforcement)

Original allows `memory_scope: 'private'` per agent. Zero test coverage that private actually works — regression trap.

Introduce mandatory test suite:
```ts
test('private-memory agent cannot read shared episodic', async () => {
  await createAgent({ id: 'ag_shared', memoryScope: 'shared' });
  await createAgent({ id: 'ag_private', memoryScope: 'private' });
  
  // Insert into shared memory as ag_shared.
  await recallEngine.write({ agentId: 'ag_shared', content: 'SECRET_A' });
  
  // Try recall as ag_private → must NOT return SECRET_A.
  const results = await recallEngine.query({ agentId: 'ag_private', query: 'SECRET' });
  expect(results.every(r => !r.content.includes('SECRET_A'))).toBe(true);
});

test('shared-memory agent DOES read shared episodic', async () => {
  await createAgent({ id: 'ag_shared1', memoryScope: 'shared' });
  await createAgent({ id: 'ag_shared2', memoryScope: 'shared' });
  
  await recallEngine.write({ agentId: 'ag_shared1', content: 'SHARED_INFO' });
  const results = await recallEngine.query({ agentId: 'ag_shared2', query: 'SHARED' });
  expect(results.some(r => r.content.includes('SHARED_INFO'))).toBe(true);
});
```

Fits pattern din audit runda 10 §256 (missing RSI safety regression tests). Same principle: invariants nu-s free — need enforcement tests.

### R7 — Agent lifecycle events + audit log

Multi-agent introduces failure modes single-agent hasn't:
- Agent A deleted mid-delegation din B — B's return address invalid.
- Agent A model changed mid-conversation — earlier context assumes model X, next turn X unavailable.
- Two agents concurrently modify shared skill → race.

Fix: `agent_lifecycle_log` table (append-only):
```sql
CREATE TABLE agent_lifecycle_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  event_type TEXT NOT NULL,   -- 'created' | 'modified' | 'deleted' | 'delegated_out' | 'delegated_in' | 'handoff_out' | 'handoff_in' | 'model_switched'
  actor TEXT,                  -- user OR another_agent_id
  detail_json TEXT             -- structured event data
);
```

Deletion policy: NEVER hard-delete agent. Soft-delete cu `deleted_at` — history preserved. Delegations reference by id remain resolvable (returns "agent deleted" instead of null).

Cross-check with L3 delegation: `spawn_delegation` writes `delegated_out` for A, `delegated_in` for B. Complete graph reconstructible from log.

## Migration order (revised)

- **v0.4**: L1 first-class agents + R5 skills scoping + R7 lifecycle log
- **v0.5**: L2 concurrent + R4 model pool + R2 cost pooling + R6 isolation tests
- **v0.6**: L3 delegation + R1 permission inheritance (SECURITY) + R3 handoff
- Regressions: audit findings §142/§190 (RLM escape / lora path) MUST be fixed înainte de L3 (delegation exploits scale)

## References

- Existing: `frontend-react/src/stores/agent.ts`, `FeralAgent/src/rlm/children.ts`
- Related: ADR-0014 (Brain Stack), ADR-0016 (Community — succesor logic)
- Related audit: §142 (RLM proto leak), §190 (rsi_set_lora unbounded) — prerequisite fixes
- Inspiration: Hermes Bot Mode (per user description)
