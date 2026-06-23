# Design — Remove memory CRUD + fum-RSI skills, preserve recall (Pathway 3, step 1)

> Status: design approved (Darius, 2026-06-23). Single PR.
> Branch of work: `main` (clean substrate before the Pathway-3 reactive engine).
> This is **step 1** of Pathway 3 ("native single-agent RSI"): clean the substrate.
> Step 2 (the reactive memory engine: write → hook → reconcile → Mandelbrot pulse)
> gets its **own** spec and is explicitly out of scope here.

---

## Goal

Kill the manual CRUD memory surface and the "self-improving via skills" subsystem
(the *fum-RSI* the Council analysis flagged), while **preserving semantic recall**.
Memory capture becomes 100% reactive (the existing `MemoryExtractor`); recall stays
available both automatically (per-turn injection) and on-demand (a new read-only
`recall` tool that exposes the RAPTOR/Fractal stack).

## Non-goals (owned by the Pathway-3 step-2 spec)

- The reactive engine (event bus: memory write → hook → reconcile → propagate edges
  → Mandelbrot pulse).
- Any change to the recall **engine** or routing (we keep `FractalMemory` over
  `RecallEngine`).
- Migrating the ~41 facts from the old engine's store to a hooks-based engine. That
  migration is triggered only by a routing change, which this PR does **not** do.

---

## Verification done before committing (evidence to repeat in PR description)

Three blockers were raised and resolved against the current `main` checkout:

1. **Auto-inject is LIVE on main — no blind window.** The recaller is wired
   end-to-end today, independent of `memory_ops`:
   - `index.ts:256` `new RecallEngine(episodic, semantic)`
   - `index.ts:307` `new FractalMemory({...})` (wraps RecallEngine, falls back to it)
   - `index.ts:595-603` `new AgentLoop(router, registry, episodic, {...}, fractalMemory, extractor, …)`
     — `fractalMemory` is the `recall: Recaller` argument
   - `agent-loop.ts:552-554` every turn: `await this.#recall.recall(userText, sessionId)`
     → `memory.setMemoryContext(result.context)`

   Because auto-inject already ships on `main`, a **single PR never blinds the agent**.
   (The two-PR split was only required under the false premise that auto-inject would
   land in the same PR as Pathway 3.)

2. **`read_skill` reads from PATH, not `SkillsStorage`.** `read-skill.ts:114-122`
   reads `${skillsDir}/${id}/SKILL.md` directly via `readFile`; it never imports
   `SkillsStorage`. The "Available skills" menu comes from `msg.skillsContext`
   (`index.ts:1017`), supplied per-turn by the transport — not from `SkillsStorage`.
   Remaining `SkillsStorage` consumers are exactly the three modules being removed
   (`index.ts` skillCreator wiring, `feedback-skill.ts`, `self-improve.ts`), so
   `storage.ts` becomes dead after removal. **Verify-then-delete**: re-run the grep
   at implementation time and paste the zero-consumer result into the PR description.

3. **The ~41 facts are not coupled to the tool.** Facts live in `SemanticMemory`
   (SQLite); `memory_ops` is only a CRUD accessor. Deleting the tool leaves the store
   intact, and the live recaller keeps reading + injecting it. Zero fact loss in this
   PR. Migration is deferred to the Pathway-3 step-2 spec.

---

## Components

### Removed

| Path | What it was | Why it goes |
|---|---|---|
| `tools/builtin/memory-ops.ts` | CRUD over semantic memory (`get`/`search`/`add`/`forget`/`list`) + Fractal episodic facade | CRUD dies; capture is reactive. Recall half is re-homed in `recall.ts`. |
| `tools/builtin/memory-graph-ops.ts` | CRUD over the knowledge graph | Same "CRUD-only, no hooks" bottleneck. Graph stays fed by the extractor. |
| `skills/auto-create.ts` | Fabricates skills from conversation | fum-RSI (text nudges, not weights). Competes with the real RSI moat. |
| `skills/self-improve.ts` | "Refines" skills | fum-RSI. |
| `tools/builtin/feedback-skill.ts` | `feedback_skill` tool → `SkillSelfImprover` | fum-RSI surface. |
| `skills/storage.ts` | `SkillsStorage` manifest store | Dead after the three above are removed (verify-then-delete). |

### Added

- **`tools/builtin/recall.ts`** — read-only on-demand semantic search.
  - Params: `query: string` (required), `limit?: number` (default 5, clamped).
  - Body: `await fractalMemory.query(query, limit)` → ranked `{ leafId, text }` hits,
    rendered as a `Related past conversations:` block (200-char snippet truncation,
    same shape `memory_ops search` produced).
  - Manifest: `permissions: []`, `networkAccess: false`. No writes, ever.
  - Justification beyond auto-inject: auto-inject is keyed on the current turn's
    `userText`; this tool lets the agent search mid-task with **different** terms
    (e.g. "what did the user say about X, 8 messages ago?").

### Decoupled (kept, edited)

- **`memory/extractor.ts`** — drop the `skillCreator` constructor param, the
  `#skillCreator` field, and the `shouldSkill` / `maybeCreate` block (~lines 124,
  140-142). Capture (semantic + graph) is unchanged.
- **`index.ts`** — remove: the three tool registrations (`memory_ops`,
  `memory_graph`, `feedback_skill`); the `SkillAutoCreator` + `skillsStorage`
  construction and its `onCreated`/`sendHolder` wiring; the `FERAL_SKILL_AUTO_CREATE`
  knob. `MemoryExtractor` is constructed as `new MemoryExtractor(router, semantic, episodic)`.
  Register the new `recall` tool with the same `fractalMemory.query` closure that
  `memory_ops` used.
- **`types.ts`** — remove the `skill_created` OutboundEvent variant (`types.ts:993`)
  once no emitter remains.

### Untouched (explicit)

- `read_skill` (a pure path loader, not part of the CRUD/fum-RSI surface).
- `proactive` subsystem (`mood.ts`, `inner-thoughts.ts`) — already opt-in, off by
  default.
- `MemoryGraph` class, `src-tauri/src/memory_graph.rs`, the Memory Graph UI — the
  graph is still populated by the extractor and still visualized; only its CRUD tool
  surface is removed.

---

## Data flow (after)

- **Capture**: conversation → `MemoryExtractor` (automatic, fire-and-forget) →
  `SemanticMemory` + `MemoryGraph`. No manual CRUD.
- **Recall (automatic)**: every turn → `agent-loop` `#recall.recall(userText)` →
  `result.context` injected into working memory.
- **Recall (on-demand)**: agent calls `recall` tool → `fractalMemory.query()` →
  ranked past-conversation snippets.

## Error handling

- `recall` is best-effort: a fractal failure or missing embedding model degrades to
  an empty result (mirrors the existing `memory_ops search` try/catch), never throws
  into the turn.
- `recall` validates `query` is a non-empty string and clamps `limit` to a sane range;
  bad args return a structured `bad_args` result.

## Testing

- **Delete** `tests/memory-ops-fractal-facade.test.ts` (tool gone).
- **Add** `tests/recall.test.ts` — covers: ranked output shape, empty/missing-model
  degradation, `limit` clamping, bad-args rejection.
- **Update** `tests/openai-native-tools.test.ts` — drop `memory_ops`/`memory_graph`
  assertions; add `recall`.
- **Update/trim** `tests/skills.test.ts` — remove auto-create / self-improve coverage;
  keep anything covering `read_skill` / storage-independent behavior.
- **Check** `tests/feral-prompt.test.ts` — if it asserts a tool roster mentioning the
  removed tools, update it.
- Gate: full sidecar test suite green + `tsc` clean before commit.

## Trade-off (accepted)

Explicit "remember X" / "forget Y" lose their immediate path; capture is purely
reactive and recall surfaces only *relevant* facts (auto-inject) rather than an
enumerable list. Reactive reconciliation/forgetting is owned by the Pathway-3 step-2
spec.

---

## PR shape

Single PR, two commits for clean review:
1. **Additive** — `recall.ts` + `recall.test.ts` + register in `index.ts`.
2. **Destructive** — delete the six files, decouple the extractor, prune `index.ts`
   wiring + `types.ts` event, update/trim tests.

PR description must include: the three evidence blocks above + the verify-then-delete
grep output for `SkillsStorage`.
