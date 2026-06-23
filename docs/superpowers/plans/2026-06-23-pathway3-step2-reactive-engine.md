# Plan — Reactive Memory Engine (Pathway 3, step 2)

> Plan for: `docs/superpowers/specs/2026-06-23-pathway3-step2-reactive-engine-design.md`
> 4 tasks, TDD, single PR. Additive changes only.
> Branch: `feat/pathway3-step2-reactive-engine`, off the merged step-1 head.

## Conventions

- One task = one commit. Each commit is GREEN: `cd FeralAgent && bunx tsc --noEmit && bun test`.
- Every task ships its own tests FIRST. Test names appear in the brief.
- `tsconfig` has `noUnusedLocals` + `noUnusedParameters` = true. No unused symbols.
- Verify-then-delete greps return exactly the expected matches; STOP and report otherwise.
- DO NOT touch: `frontend-react/`, `src-tauri/`, `MemoryExtractor` extraction logic, `MemoryGraph.addFact`, `FractalMemory.query()`.

## Pre-flight (verify before Task 1)

```
cd FeralAgent && bunx tsc --noEmit          # exit 0
cd FeralAgent && bun test                   # 965 pass / 0 fail baseline (post step-1 merge)
git log --oneline -3                        # step-1 head is current
git status                                  # clean working tree
```

If anything is off, STOP. The plan assumes the step-1 PR (#2) is merged and the test baseline is the one Opus recorded in `.superpowers/sdd/progress.md` (965/0).

---

## Task 1 — Add the `after_memory_write` hook event (additive)

**Goal**: a new event on the existing `HookRegistry` that fires from the
extractor every time it writes a fact or observation. No behaviour
change for the substrate yet — no subscribers, just the event.

**Brief**: `.superpowers/sdd/task-1-brief.md` (to be created at start of task).

### Files to edit
- `FeralAgent/src/types.ts` — add `AfterMemoryWritePayload` interface and add `"after_memory_write"` to the `HookEvent` union.
- `FeralAgent/src/core/hook-registry.ts` — extend the `HookHandler<E>` overload list with the new event so type-checking still works (mirror the pattern used for `before_tool_call` etc.).
- `FeralAgent/src/memory/extractor.ts` — accept an optional `hooks: HookRegistry | null = null` constructor argument; in `#extractFactsAndObservation`, fire the event ONCE per written fact (after `this.#semantic.upsert(...)`) and ONCE per observation (after `this.#episodic.record(...)`). Never fire on `SKIP` / `NONE` / parse-fail.
- `FeralAgent/src/index.ts` — pass `hooks` into the new `MemoryExtractor` constructor call.

### Payload shape (frozen — copy into types.ts verbatim)

```ts
export type AfterMemoryWriteKind = "fact" | "observation";

export interface AfterMemoryWritePayload {
  kind: AfterMemoryWriteKind;
  sessionId: string;
  ts: number;                  // Date.now()
  // for "fact"
  key?: string;
  value?: string;
  // for "observation"
  obsType?: import("./memory/extractor.ts").ObservationType;
  title?: string;
  concepts?: string[];
}
```

### Tests (write first; must fail before the code edit)

`FeralAgent/tests/memory-write-hook.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "bun:test";
import { HookRegistry } from "../src/core/hook-registry.ts";

describe("after_memory_write hook event", () => {
  let hooks: HookRegistry;
  beforeEach(() => { hooks = new HookRegistry(); });

  it("fires once per fact write and carries the fact payload", async () => {
    const seen: unknown[] = [];
    hooks.on("after_memory_write", (p) => { seen.push(p); return { block: false }; });
    await hooks.fire("after_memory_write", {
      kind: "fact", sessionId: "s1", ts: 1,
      key: "language", value: "ro",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "fact", key: "language", value: "ro" });
  });

  it("returns the first blocking result if any handler blocks", async () => {
    hooks.on("after_memory_write", () => ({ block: true, reason: "test-block" }));
    const r = await hooks.fire("after_memory_write", { kind: "fact", sessionId: "s", ts: 0 });
    expect(r).toEqual({ block: true, reason: "test-block" });
  });

  it("a misbehaving handler does not crash the pipeline", async () => {
    hooks.on("after_memory_write", () => { throw new Error("boom"); });
    const r = await hooks.fire("after_memory_write", { kind: "fact", sessionId: "s", ts: 0 });
    expect(r).toBeNull();
  });
});
```

`FeralAgent/tests/extractor-hook-fire.test.ts` (or appended to the
existing extractor test file if it exists):

```ts
import { describe, it, expect } from "bun:test";
import { MemoryExtractor } from "../src/memory/extractor.ts";
import { HookRegistry } from "../src/core/hook-registry.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";
// ... build minimal fakes for router, episodic, graph per existing tests

describe("MemoryExtractor fires after_memory_write", () => {
  it("fires once per fact line on the FACTS path", async () => {
    const seen: any[] = [];
    const hooks = new HookRegistry();
    hooks.on("after_memory_write", (p) => { seen.push(p); return { block: false }; });
    // ... wire extractor with hooks, run #extract on a transcript
    //     with two fact lines ("language: ro\nname: Darius")
    expect(seen.filter((s) => s.kind === "fact")).toHaveLength(2);
  });

  it("fires once per observation on the OBSERVATION path", async () => {
    // mirror above with an obs-emitting transcript
  });

  it("does NOT fire when the response is NONE / SKIP", async () => {
    const seen: any[] = [];
    const hooks = new HookRegistry();
    hooks.on("after_memory_write", (p) => { seen.push(p); return { block: false }; });
    // transcript that returns NONE / SKIP
    expect(seen).toHaveLength(0);
  });
});
```

### Verify-then-grep (mandatory before commit)

```
cd FeralAgent && grep -rn "after_memory_write" src/ tests/
```

Expected matches: the new event literal in `types.ts` + `hook-registry.ts`
+ `extractor.ts` + the two new tests. Nothing else. If `index.ts` already
references it (because we pass it in the constructor), that match is fine.

### Gate
```
cd FeralAgent && bunx tsc --noEmit
cd FeralAgent && bun test
```
Must be green; test count must be `baseline + 3 + 3 = baseline + 6` (3 in
memory-write-hook.test.ts + 3 in extractor-hook-fire.test.ts).

### Commit message
```
feat(memory): add after_memory_write hook event (additive)

- types.ts: AfterMemoryWritePayload + event in HookEvent union
- hook-registry.ts: overload HookHandler<E> for the new event
- extractor.ts: optional hooks ctor arg; fires on every fact/obs write
- index.ts: wire hooks into MemoryExtractor construction

No subscribers yet. No behaviour change. Spec: docs/superpowers/specs/
2026-06-23-pathway3-step2-reactive-engine-design.md
```

### Append to progress.md
```
- Task 1: complete (commits <base7>..<head7>, review pending, +6 tests)
```

---

## Task 2 — `Reconciler` class + subscription

**Goal**: a class that listens to `after_memory_write` and (for now) logs
the payload. Real work — `upsertLeaf` and graph reconcile — comes in
Tasks 3 and 4. This task makes the subscription pattern testable.

**Brief**: `.superpowers/sdd/task-2-brief.md`.

### Files to add
- `FeralAgent/src/memory/reconciler.ts` — exports `class Reconciler` with:
  - constructor `(deps: { hooks: HookRegistry; fractal: FractalMemory; graph: MemoryGraph; })`
  - private `#unsubscribe: Unsubscribe | null = null`
  - `start(): void` — subscribes; idempotent (calling twice is a no-op)
  - `stop(): void` — calls unsubscribe; idempotent
  - private `handle(payload: AfterMemoryWritePayload): Promise<void>` — for THIS task, just `console.debug("[reconciler]", payload)` and return. No tree/graph side-effects yet.

### Files to edit
- `FeralAgent/src/index.ts` — construct `new Reconciler({ hooks, fractalMemory, memoryGraph })` and `.start()` after `fractalMemory.init()` (so the fractal is ready before any write fires).

### Tests (write first; fail before code)

`FeralAgent/tests/reconciler.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "bun:test";
import { Reconciler } from "../src/memory/reconciler.ts";
import { HookRegistry } from "../src/core/hook-registry.ts";
// stub FractalMemory + MemoryGraph per the existing test fixtures

describe("Reconciler", () => {
  let hooks: HookRegistry;
  let fractal: any;
  let graph: any;

  beforeEach(() => {
    hooks = new HookRegistry();
    fractal = { upsertLeaf: () => {}, /* stub */ };
    graph = { reconcile: () => {} };
  });

  it("subscribes on start and unsubscribes on stop", async () => {
    const r = new Reconciler({ hooks, fractal, graph });
    r.start();
    expect(hooks.countFor("after_memory_write")).toBe(1);
    r.stop();
    expect(hooks.countFor("after_memory_write")).toBe(0);
  });

  it("start() is idempotent — second call does not double-subscribe", () => {
    const r = new Reconciler({ hooks, fractal, graph });
    r.start(); r.start();
    expect(hooks.countFor("after_memory_write")).toBe(1);
  });

  it("stop() before start() is a no-op (does not throw)", () => {
    const r = new Reconciler({ hooks, fractal, graph });
    expect(() => r.stop()).not.toThrow();
  });

  it("receives the payload when the event fires", async () => {
    const r = new Reconciler({ hooks, fractal, graph });
    const seen: any[] = [];
    r.start();
    // re-stub handle via spy? Or — for this task — assert that the
    // payload is observable via a side effect stub on fractal/graph.
    // Concretely: graph.reconcile is NOT called yet (Task 3 wires it).
    await hooks.fire("after_memory_write", { kind: "fact", sessionId: "s", ts: 0, key: "k", value: "v" });
    expect(graph.reconcile).not.toHaveBeenCalled();
    expect(fractal.upsertLeaf).not.toHaveBeenCalled();
  });
});
```

### Verify-then-grep
```
cd FeralAgent && grep -rn "Reconciler" src/
```
Expected matches: the new file + index.ts construction + the test. Nothing
in `extractor.ts` (Task 3 will add `upsertLeaf` call inside the
reconciler, not the extractor).

### Gate
```
cd FeralAgent && bunx tsc --noEmit && bun test
```
Test count: `previous + 4 = baseline + 10`.

### Commit message
```
feat(memory): Reconciler subscribes to after_memory_write (no-op handler)

- memory/reconciler.ts: class with start()/stop(), idempotent, handler is
  a debug-log no-op for now
- index.ts: construct + start() at boot, after fractalMemory.init()
- tests/reconciler.test.ts: 4 tests

Subscribes but does nothing yet. Tree wiring is Task 3. Spec: docs/
superpowers/specs/2026-06-23-pathway3-step2-reactive-engine-design.md
```

### Append to progress.md
```
- Task 2: complete (commits <base7>..<head7>, review pending, +4 tests)
```

---

## Task 3 — `FractalMemory.upsertLeaf` + reconciler wires it in

**Goal**: when an `after_memory_write` fires, the reconciler computes an
embedding for the fact and calls `upsertLeaf`. Near-duplicate facts bump
`last_seen_at` on the existing leaf and emit a `seed` pulse; novel facts
add a leaf and emit a `grow` pulse.

**Brief**: `.superpowers/sdd/task-3-brief.md`.

### Files to edit
- `FeralAgent/src/memory/fractal/fractal-memory.ts` — add:
  - `public async upsertLeaf(opts: { text: string; embedding: number[]; provenance: { source: string; first_seen_at: number; sessionId: string; ts: number; key?: string; value?: string; } }): Promise<{ kind: "grow"; leafId: number } | { kind: "seed"; leafId: number }>`
  - Internals: nearest-neighbour scan against the existing cluster index (same scan as `query()` uses for ANN), compare cosine, decide merge-vs-insert based on `FERAL_MERGE_THRESHOLD`. Emit activity via the existing `#onActivity` callback. Bump `mutation_seq`. Persist tree on insert (the existing `treePath` write path).
  - Idempotent: `upsertLeaf` called twice with the same `(embedding, provenance.first_seen_at)` must NOT create two leaves. Use a `provenanceKey = sha256(text + first_seen_at)` and dedup on that.
- `FeralAgent/src/memory/reconciler.ts` — replace the debug-log handler body with a real implementation:
  - Compute `embedding = await this.#deps.embed(payload)` (using the same `embed()` the sidecar already uses; expose it as a constructor arg).
  - Build the provenance object from `AfterMemoryWritePayload`.
  - Call `fractal.upsertLeaf({ text, embedding, provenance })`.
  - For `observation` writes: also call `graph.reconcile(treeView)`. (For Task 3 we stub `treeView` to a minimal snapshot; Task 4 wires the real tree view.)

### Files to edit
- `FeralAgent/src/index.ts` — pass `embed: (text) => embed(text)` into the reconciler constructor.

### Tests (write first)

`FeralAgent/tests/upsert-leaf.test.ts`:

```ts
describe("FractalMemory.upsertLeaf", () => {
  it("adds a new leaf when the embedding is far from any existing leaf", async () => {
    // build a tiny FractalMemory fixture (3 random leaves)
    // call upsertLeaf with a clearly-different embedding
    // assert: leaves.length increased by 1
    // assert: #onActivity fired with { kind: "grow", leafId: <new id> }
    // assert: mutation_seq bumped
  });

  it("merges (no new leaf) when cosine >= MERGE_THRESHOLD", async () => {
    // insert a leaf, then upsert with a near-identical embedding
    // assert: leaves.length unchanged
    // assert: #onActivity fired with { kind: "seed", leafId: <existing id> }
    // assert: the existing leaf's last_seen_at was bumped
  });

  it("is idempotent on (text, first_seen_at) duplicates", async () => {
    // upsertLeaf with the same args twice
    // assert: leaves.length grew by exactly 1
    // assert: second call emitted no pulse (already there)
  });

  it("respects FERAL_MERGE_THRESHOLD env override", async () => {
    // set env to 0.99, insert, then upsert with sim=0.95
    // assert: still merges (below threshold would mean new leaf at 0.99)
  });
});

describe("Reconciler with upsertLeaf wired", () => {
  it("calls upsertLeaf on every fact write with the right text shape", async () => {
    // spy on fractal.upsertLeaf; fire after_memory_write
    // expect the call args to be: text = `${key}: ${value}`, embedding = <provided by embed stub>, provenance.first_seen_at = ts
  });

  it("does not throw if embed() returns null (model missing)", async () => {
    // embed stub returns null
    // fire event
    // expect: no upsertLeaf call, no error
  });
});
```

### Verify-then-grep
```
cd FeralAgent && grep -rn "upsertLeaf" src/ tests/
```
Expected: fractal-memory.ts (definition + call sites) + reconciler.ts +
tests. Nothing in `extractor.ts` (the reconciler owns the call).

### Gate
```
cd FeralAgent && bunx tsc --noEmit && bun test
```
Test count: `previous + 7 = baseline + 17`.

### Commit message
```
feat(memory): FractalMemory.upsertLeaf + reconciler wires it in

- fractal-memory.ts: upsertLeaf with cosine-merge, idempotent on
  (text, first_seen_at), env-tunable threshold, mutation_seq bump,
  emits grow/seed via existing onActivity
- reconciler.ts: handler calls embed() + upsertLeaf; tolerant of
  missing model
- index.ts: pass embed into reconciler deps
- tests/upsert-leaf.test.ts: 7 tests

Spec: docs/superpowers/specs/2026-06-23-pathway3-step2-reactive-engine-design.md
```

### Append to progress.md
```
- Task 3: complete (commits <base7>..<head7>, review pending, +7 tests)
```

---

## Task 4 — Migration of the ~41 facts + graph coupling

**Goal**: one-shot migration at boot, idempotent via marker file. The
graph reconcile for observation writes is wired in for real.

**Brief**: `.superpowers/sdd/task-4-brief.md`.

### Files to add
- `FeralAgent/src/memory/fractal/migration.ts` — exports:
  - `async function runMigration(deps: { semantic: SemanticMemory; fractal: FractalMemory; paths: { marker: string } }): Promise<{ ran: boolean; facts: number; error?: string }>`
  - Marker at `<dataDir>/fractal-migration-v1.done`. Atomic write (write tmp, rename).
  - Reads every fact via `semantic.all()` (or equivalent iterator), calls `fractal.upsertLeaf` for each.
  - **Idempotent**: if marker exists, return `{ ran: false }` immediately.
  - **Failure tolerant**: if any `upsertLeaf` throws (e.g. embedding model missing), log + return `{ ran: false, error: "..." }` WITHOUT writing the marker. Next boot retries.
  - **No-op on empty store**: if `semantic.all()` returns 0 facts, write the marker anyway (clean state).

### Files to edit
- `FeralAgent/src/memory/reconciler.ts` — for `observation` payloads, after `upsertLeaf`, call `graph.reconcile(fractal.treeView())`. `treeView()` is a new method on `FractalMemory` exposing the cluster + leaf summary the graph needs (added in this task as a thin read-only helper; no behaviour change to existing query / rebuild paths).
- `FeralAgent/src/index.ts` — after `reconciler.start()`, `void runMigration(...)`. Log the outcome (`ran`, `facts`, `error`).

### Tests (write first)

`FeralAgent/tests/migration.test.ts`:

```ts
describe("runMigration", () => {
  it("writes the marker after processing all facts", async () => {
    // fixture: SemanticMemory with 5 facts, no marker
    // call runMigration
    // expect: marker file exists, fractal.upsertLeaf called 5 times
  });

  it("is a no-op when the marker is present (does not re-upsert)", async () => {
    // fixture: marker present, 5 facts in semantic
    // call runMigration
    // expect: upsertLeaf called 0 times, ran = false
  });

  it("does NOT write the marker if any upsertLeaf throws", async () => {
    // fractal.upsertLeaf throws on the 3rd call
    // expect: marker absent after the call, error string returned
  });

  it("writes the marker when the store is empty (clean state)", async () => {
    // semantic.all() returns []
    // expect: marker exists, upsertLeaf called 0 times
  });

  it("uses an atomic write (tmp + rename) for the marker", async () => {
    // spy on writeFile + rename; assert tmp path was renamed, not direct
  });
});

describe("Reconciler observation path", () => {
  it("calls graph.reconcile with a treeView snapshot", async () => {
    // fire after_memory_write with kind: "observation"
    // expect: graph.reconcile called with { clusters: [...], leaves: [...] }
  });
});
```

### Verify-then-grep
```
cd FeralAgent && grep -rn "fractal-migration-v1\|runMigration\|treeView" src/ tests/
```
Expected matches: `migration.ts` (definition + marker constant), `index.ts`
(the `void runMigration(...)` call), `reconciler.ts` (the `treeView()` call),
the test file. The marker string MUST appear exactly once in `migration.ts`
(de-duplicated to a constant). If it appears anywhere else, STOP.

### Gate
```
cd FeralAgent && bunx tsc --noEmit && bun test
```
Test count: `previous + 7 = baseline + 24`.

### Commit message
```
feat(memory): migrate pre-step1 facts + wire graph reconcile

- memory/fractal/migration.ts: idempotent one-shot runner, marker at
  fractal-migration-v1.done, atomic write, failure-tolerant
- fractal-memory.ts: read-only treeView() for graph reconcile
- reconciler.ts: observation writes also call graph.reconcile(treeView)
- index.ts: void runMigration() at boot, log outcome
- tests/migration.test.ts: 7 tests

Spec: docs/superpowers/specs/2026-06-23-pathway3-step2-reactive-engine-design.md
```

### Append to progress.md
```
- Task 4: complete (commits <base7>..<head7>, review pending, +7 tests)
```

---

## Final review + PR

### Re-run the full gate
```
cd FeralAgent && bunx tsc --noEmit
cd FeralAgent && bun test                  # baseline + 24 tests, 0 fail
```

### Branch
`feat/pathway3-step2-reactive-engine`, off the merged step-1 head. Push
to origin. Open ONE PR.

### PR description — required sections

1. **Scope justification** — paste the two paragraphs from step-1 spec
   ("Reactive engine + fact migration are deferred to the Pathway-3
   step-2 spec.") verbatim. These are the evidence that step 2 is the
   correct next move and not scope creep.
2. **What landed** — list the 4 commits, one line each.
3. **DO-NOT-TOUCH compliance** — explicit grep results:
   - `grep -rn "frontend-react\|src-tauri" FeralAgent/src/` → 0 matches in **new** files
   - `grep -rn "MemoryGraph.addFact\|FractalMemory.query" FeralAgent/src/memory/reconciler.ts` → 0 matches
4. **Migration evidence**:
   - `grep -rn "fractal-migration-v1.done" src/ tests/` → exactly 1 match in `migration.ts` (the constant)
   - Test count: `baseline + 24`
5. **Known minor items** (from earlier task reviews, optional fixes):
   - Reconciler accepts an `embed` stub in tests via constructor injection — production wires the real `embed()`. This is the recommended pattern from the bench orchestrator.

### Conventions reminder

- No amend. No force-push. Frequent, scoped commits (already done above).
- Append progress.md after every task.
- STOP and report on any unexpected grep match.
