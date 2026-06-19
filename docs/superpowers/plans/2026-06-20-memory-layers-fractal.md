# Memory Layers — Fractal Reskin + RSI UI Removal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the RSI control-panel UI (engine keeps running passively), move its spend control into Settings as a literal USD cap, and reskin the knowledge-graph tab as a user-driven WebGL2 Mandelbrot ("Memory Graph" → "Memory Layers").

**Architecture:** Three independent threads. (1) Frontend deletions + a rename. (2) A thin token→USD budget layer in the Bun/TS sidecar (`rsi-cost.ts` + `GoalMode`) fed by a Settings value that flows Rust `Settings` → env → `passiveStartOptions`. (3) A new WebGL2 fractal renderer (`mandelbrot.ts` + `MandelbrotCanvas`) plus a seeded node-layout overlay (`layout.ts` + `NodeOverlay`) composed into the renamed page, reusing the existing `getGraph()` data and control chrome.

**Tech Stack:** Rust/Tauri (`src-tauri`), Bun + TypeScript sidecar (`FeralAgent`, tests via `bun test`), React 18 + Zustand + Tailwind frontend (`frontend-react`, tests via `vitest`), raw **WebGL2** (no new dependency).

## Global Constraints

- **No new runtime dependencies.** WebGL2 is used raw (no three/regl). Rationale: the codebase already code-splits `vis-network` for bundle weight.
- **Spec source of truth:** `docs/superpowers/specs/2026-06-20-memory-layers-fractal-design.md`.
- **Sidecar is a compiled binary.** Any change under `FeralAgent/` only takes effect in the running app after `cd FeralAgent && bun run build` and copying the produced `.exe` to `src-tauri/binaries/`. `cargo tauri dev` does NOT rebuild it. Unit tests (`bun test`) run against source directly and do not need the rebuild.
- **Budget is a literal USD cap.** Default `$0` = local-only. Local inference (loopback `baseUrl`) is **always** free → `$0` lets the engine run forever locally and spend nothing; cloud spend halts at the cap. The `$0`-on-local guarantee is exact; cloud pricing is an approximate blended estimate.
- **The Mandelbrot view has NO automatic motion.** No auto-drift, auto-zoom, breathing, or tour. The backdrop is static until the user zooms (wheel toward cursor) or pans (drag). Nodes and fractal share one `center`/`scale`.
- **Theme palettes (from user references):** light = Seahorse/Elephant-Valley lavender/periwinkle on near-white; dark = black field with brand orange→amber→red→cream ember bands. View opens at Seahorse Valley `center ≈ (-0.745, 0.113)`.
- **Smooth coloring required:** normalized iteration count `mu = n + 1 - log2(log2(dot(z,z)))`, not stepped bands.
- **Don't touch the passive engine's lifecycle** (`passive-supervisor.ts` autostart) beyond adding the cost cap. RSI stays headless.
- After each task: run that task's tests green before committing. Commit per task.

---

## File Structure

**Deleted**
- `frontend-react/src/pages/RsiPage.tsx`
- `frontend-react/src/pages/__tests__/RsiPage.test.ts`

**Created**
- `FeralAgent/src/rsi/rsi-cost.ts` — pure token→USD estimator + price table.
- `FeralAgent/tests/rsi-cost.test.ts`
- `frontend-react/src/pages/MemoryLayersPage.tsx` — renamed from `MemoryGraphPage.tsx`, rendering swapped to the fractal.
- `frontend-react/src/lib/fractal/mandelbrot.ts` — WebGL2 program + GLSL + `screenToComplex`/`complexToScreen` helpers.
- `frontend-react/src/components/memory/MandelbrotCanvas.tsx` — the WebGL2 canvas (user zoom/pan, theme palette, reset/jump).
- `frontend-react/src/lib/fractal/layout.ts` — seeded deterministic node layout (pure).
- `frontend-react/src/components/memory/NodeOverlay.tsx` — Canvas2D vector node/edge layer with hit-testing + LOD.
- Test files: `frontend-react/src/lib/fractal/__tests__/mandelbrot.test.ts`, `layout.test.ts`.

**Modified**
- `FeralAgent/src/rsi/goal-mode.ts` — cost cap fields + accrual + `CostBudgetExhausted`.
- `FeralAgent/src/rsi/sidecar.ts` — thread `maxTotalCostUsd`/`pricePer1kUsd` into the engine `goal` config.
- `FeralAgent/src/rsi/passive-supervisor.ts` — read `FERAL_RSI_MAX_COST_USD` into options.
- `src-tauri/src/settings.rs` — `rsi_max_cost_usd: Option<f64>`.
- `src-tauri/src/lib.rs` — `set_rsi_budget` command + register + boot env export.
- `frontend-react/src/lib/tauri/index.ts` — `Settings.rsi_max_cost_usd`, `raw.setRsiBudget`, `settings.setRsiBudget`.
- `frontend-react/src/stores/settings.ts` — `setRsiBudget` action.
- `frontend-react/src/components/settings/AgentSettingsTab.tsx` — new `RsiBudgetControl`.
- `frontend-react/src/components/layout/Sidebar.tsx` — nav label/action; remove `rsi` item.
- `frontend-react/src/router.tsx` — route rename + redirect; remove `/rsi`.

---

## Task 1: Remove the RSI control surface (frontend)

**Files:**
- Delete: `frontend-react/src/pages/RsiPage.tsx`, `frontend-react/src/pages/__tests__/RsiPage.test.ts`
- Modify: `frontend-react/src/components/layout/Sidebar.tsx`, `frontend-react/src/router.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing (pure removal). After this task `/rsi` no longer exists and no nav item references it.

- [ ] **Step 1: Delete the page and its test**

```bash
git rm frontend-react/src/pages/RsiPage.tsx frontend-react/src/pages/__tests__/RsiPage.test.ts
```

- [ ] **Step 2: Remove the nav item in `Sidebar.tsx`**

Delete the `Fractal Memory` MENU entry (the `CircuitBoard` / `action: 'rsi'` line, currently `Sidebar.tsx:48`):

```tsx
  { icon: CircuitBoard, label: 'Fractal Memory', shortcut: null, action: 'rsi',       disabled: false, route: '/rsi' },
```

Remove `'rsi'` from the `MenuAction` union (`Sidebar.tsx:27`): change
`... | 'memoryGraph' | 'rsi';` to `... | 'memoryGraph';`. If `CircuitBoard` is now an unused import, remove it from the `lucide-react` import line.

- [ ] **Step 3: Remove the route in `router.tsx`**

Delete the lazy import line `const RsiPage = lazy(...)` (`router.tsx:15`) and the route `{ path: 'rsi', element: lazyPage(<RsiPage />) },` (`router.tsx:34`).

- [ ] **Step 4: Verify typecheck + build pass (no dead imports)**

Run: `cd frontend-react && npm run typecheck`
Expected: PASS, no errors referencing `RsiPage`, `CircuitBoard`, or `parseRsiEngineEvent`.

- [ ] **Step 5: Verify the suite is green**

Run: `cd frontend-react && npx vitest run`
Expected: PASS (the deleted `RsiPage.test.ts` is gone; nothing else imported it).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(memory): remove RSI control panel UI (engine stays passive)"
```

---

## Task 2: USD cost estimator (`rsi-cost.ts`)

**Files:**
- Create: `FeralAgent/src/rsi/rsi-cost.ts`
- Test: `FeralAgent/tests/rsi-cost.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `blendedPricePer1kUsd(modelId: string, isLoopback: boolean): number` — `0` when loopback; else a model-specific or default blended `$/1k tokens`.
  - `estimateUsd(totalTokens: number, pricePer1kUsd: number): number` — `totalTokens / 1000 * pricePer1kUsd`.

- [ ] **Step 1: Write the failing test**

```ts
// FeralAgent/tests/rsi-cost.test.ts
import { describe, it, expect } from "bun:test";
import { blendedPricePer1kUsd, estimateUsd } from "../src/rsi/rsi-cost.ts";

describe("rsi-cost", () => {
  it("local (loopback) is always free regardless of model id", () => {
    expect(blendedPricePer1kUsd("anything", true)).toBe(0);
    expect(blendedPricePer1kUsd("gpt-4o", true)).toBe(0);
  });

  it("unknown cloud model falls back to the conservative default price", () => {
    expect(blendedPricePer1kUsd("some-unknown-model", false)).toBeGreaterThan(0);
  });

  it("known cloud model uses its override price", () => {
    // gpt-4o override is cheaper than the conservative default.
    const known = blendedPricePer1kUsd("gpt-4o", false);
    const unknown = blendedPricePer1kUsd("zzz-unknown", false);
    expect(known).toBeGreaterThan(0);
    expect(known).toBeLessThan(unknown);
  });

  it("estimateUsd scales linearly with tokens", () => {
    expect(estimateUsd(0, 5)).toBe(0);
    expect(estimateUsd(1000, 5)).toBeCloseTo(5, 6);
    expect(estimateUsd(2500, 4)).toBeCloseTo(10, 6);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd FeralAgent && bun test tests/rsi-cost.test.ts`
Expected: FAIL — `Cannot find module '../src/rsi/rsi-cost.ts'`.

- [ ] **Step 3: Implement `rsi-cost.ts`**

```ts
// FeralAgent/src/rsi/rsi-cost.ts
/**
 * Thin token→USD layer for the passive RSI budget cap.
 *
 * The engine measures tokens; the user sets a dollar cap (Settings). Local
 * inference runs against the bundled loopback engine and is FREE — so a
 * loopback target is always $0 and the $0 default never halts a local run.
 * Cloud pricing is an approximate blended ($/1k tokens) estimate: a
 * conservative default plus a few known-model overrides. The estimate may
 * drift; the $0-on-local guarantee does not depend on it.
 */

/** Conservative blended price for an unknown cloud model ($/1k tokens).
 *  Deliberately high so an unknown paid model can never silently outspend
 *  the cap by a wide margin. */
const DEFAULT_CLOUD_PRICE_PER_1K = 0.01;

/** Known blended (input+output averaged) $/1k-token overrides. Substring
 *  match on the model id, lowercased. Keep small; tune as prices move. */
const PRICE_OVERRIDES: ReadonlyArray<readonly [match: string, pricePer1k: number]> = [
  ["gpt-4o-mini", 0.0004],
  ["gpt-4o", 0.0075],
  ["claude-haiku", 0.002],
  ["claude-sonnet", 0.009],
  ["claude-opus", 0.045],
  ["deepseek", 0.001],
  ["kimi", 0.0015],
  ["glm", 0.0015],
  ["minimax", 0.0015],
];

/** Blended price per 1k tokens. Loopback (local engine) ⇒ 0 (free). */
export function blendedPricePer1kUsd(modelId: string, isLoopback: boolean): number {
  if (isLoopback) return 0;
  const id = (modelId ?? "").toLowerCase();
  for (const [match, price] of PRICE_OVERRIDES) {
    if (id.includes(match)) return price;
  }
  return DEFAULT_CLOUD_PRICE_PER_1K;
}

/** Estimated USD for a token count at a given $/1k price. */
export function estimateUsd(totalTokens: number, pricePer1kUsd: number): number {
  if (!(totalTokens > 0) || !(pricePer1kUsd > 0)) return 0;
  return (totalTokens / 1000) * pricePer1kUsd;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd FeralAgent && bun test tests/rsi-cost.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add FeralAgent/src/rsi/rsi-cost.ts FeralAgent/tests/rsi-cost.test.ts
git commit -m "feat(rsi): token->USD cost estimator (local=free, cloud=blended)"
```

---

## Task 3: Cost cap in `GoalMode`

**Files:**
- Modify: `FeralAgent/src/rsi/goal-mode.ts`
- Test: `FeralAgent/tests/rsi-goal-cost.test.ts` (create)

**Interfaces:**
- Consumes: `estimateUsd` from Task 2.
- Produces (for Task 4):
  - `GoalConfig.maxTotalCostUsd?: number` (undefined ⇒ no cost cap).
  - `GoalConfig.pricePer1kUsd?: number` (default 0 ⇒ local/free).
  - New `StopReason` member `"CostBudgetExhausted"`.
  - `GoalResult.totalCostUsd: number`.
  - Stop semantics: cap `> 0` ⇒ stop when `totalCostUsd >= cap`; cap `=== 0` ⇒ stop when `totalCostUsd > 0`; cap `undefined` ⇒ never (token/iteration caps still apply).

- [ ] **Step 1: Write the failing test**

```ts
// FeralAgent/tests/rsi-goal-cost.test.ts
import { describe, it, expect } from "bun:test";
import { estimateUsd, blendedPricePer1kUsd } from "../src/rsi/rsi-cost.ts";

// This test pins the cost-cap *decision* function in isolation. GoalMode
// exposes `costStop(totalCostUsd, maxTotalCostUsd)` as a pure static helper
// so the stop rule is testable without driving a full engine run.
import { costStop } from "../src/rsi/goal-mode.ts";

describe("GoalMode cost cap", () => {
  it("no cap (undefined) never stops on cost", () => {
    expect(costStop(9999, undefined)).toBe(false);
  });
  it("$0 cap = local-only: free run never stops, first paid token stops", () => {
    expect(costStop(0, 0)).toBe(false);      // local stays at 0 → keeps running
    expect(costStop(0.0001, 0)).toBe(true);  // any cloud spend halts
  });
  it("positive cap stops at or above the cap", () => {
    expect(costStop(1.99, 2)).toBe(false);
    expect(costStop(2.0, 2)).toBe(true);
    expect(costStop(2.5, 2)).toBe(true);
  });
  it("cost math is consistent with the estimator", () => {
    const price = blendedPricePer1kUsd("gpt-4o", false);
    expect(estimateUsd(1_000_000, price)).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd FeralAgent && bun test tests/rsi-goal-cost.test.ts`
Expected: FAIL — `costStop` is not exported.

- [ ] **Step 3: Implement the changes in `goal-mode.ts`**

3a. Add the import at the top of the file (near the existing imports, line ~19):

```ts
import { estimateUsd } from "./rsi-cost.ts";
```

3b. Extend `GoalConfig` (after `maxTotalTokens`, line ~29):

```ts
  /** Hard stop on cumulative token cost. */
  maxTotalTokens: number;
  /** Optional hard stop on cumulative USD cost. undefined ⇒ no cost cap.
   *  0 ⇒ local-only (any nonzero spend halts). */
  maxTotalCostUsd?: number;
  /** Blended $/1k tokens for the active model. 0 ⇒ local/free. */
  pricePer1kUsd?: number;
```

3c. Add `"CostBudgetExhausted"` to the `StopReason` union (line ~36):

```ts
export type StopReason =
  | "TargetReached"
  | "BudgetExhausted"
  | "CostBudgetExhausted"
  | "MaxIterations"
  | "PlateauPersistent"
  | "UserStopped"
  | "Converged";
```

3d. Add `totalCostUsd` to `GoalResult` (line ~44):

```ts
export interface GoalResult {
  reason: StopReason;
  iterations: number;
  best: BestRecord | null;
  totalTokens: number;
  totalCostUsd: number;
}
```

3e. Add the pure decision helper (top-level export, above the `GoalMode` class):

```ts
/** Pure cost-cap decision. `cap` undefined ⇒ never; `cap === 0` ⇒ stop on any
 *  spend (local stays at 0 so it runs forever); `cap > 0` ⇒ stop at/above cap. */
export function costStop(totalCostUsd: number, cap: number | undefined): boolean {
  if (cap === undefined) return false;
  if (cap === 0) return totalCostUsd > 0;
  return totalCostUsd >= cap;
}
```

3f. Track cost in the class. Add the field next to `totalTokens` (line ~67):

```ts
  private totalTokens = 0;
  private totalCostUsd = 0;
```

3g. Accrue cost in the `EvalComplete` handler (replace the budget-bookkeeping block at line ~83):

```ts
    // Budget bookkeeping.
    bus.on("EvalComplete", (e: RsiEvent) => {
      const tokens = (e.tokenCost as number) ?? 0;
      this.totalTokens += tokens;
      this.totalCostUsd += estimateUsd(tokens, this.config.pricePer1kUsd ?? 0);
    });
```

3h. Add the cost check inside `checkStop`, immediately after the existing token check (line ~209):

```ts
    if (this.totalTokens >= this.config.maxTotalTokens) return "BudgetExhausted";
    if (costStop(this.totalCostUsd, this.config.maxTotalCostUsd)) return "CostBudgetExhausted";
```

3i. Include `totalCostUsd` in `result()` (line ~217):

```ts
  private result(reason: StopReason, iterations: number): GoalResult {
    return {
      reason,
      iterations,
      best: this.pop.best(),
      totalTokens: this.totalTokens,
      totalCostUsd: this.totalCostUsd,
    };
  }
```

- [ ] **Step 4: Run the new test + the existing goal-mode tests**

Run: `cd FeralAgent && bun test tests/rsi-goal-cost.test.ts && bun test tests/rsi-goal-mode.test.ts`
Expected: PASS. If an existing goal-mode test asserts the exact `GoalResult` shape, update it to include `totalCostUsd: 0`.

- [ ] **Step 5: Commit**

```bash
git add FeralAgent/src/rsi/goal-mode.ts FeralAgent/tests/rsi-goal-cost.test.ts
git commit -m "feat(rsi): GoalMode USD cost cap (CostBudgetExhausted)"
```

---

## Task 4: Thread the cost cap through sidecar + passive options

**Files:**
- Modify: `FeralAgent/src/rsi/passive-supervisor.ts`, `FeralAgent/src/rsi/sidecar.ts`
- Test: `FeralAgent/tests/rsi-passive-supervisor.test.ts` (extend existing)

**Interfaces:**
- Consumes: `GoalConfig.maxTotalCostUsd`/`pricePer1kUsd` (Task 3), `blendedPricePer1kUsd` (Task 2).
- Produces: `PassiveStartOptions.maxTotalCostUsd: number`; the engine `goal` config now carries `maxTotalCostUsd` + `pricePer1kUsd` derived from `process.env`.

- [ ] **Step 1: Write the failing test (extend the passive-supervisor suite)**

```ts
// add to FeralAgent/tests/rsi-passive-supervisor.test.ts
import { passiveStartOptions } from "../src/rsi/passive-supervisor.ts";

describe("passiveStartOptions cost cap", () => {
  it("defaults to $0 (local-only) when FERAL_RSI_MAX_COST_USD is unset", () => {
    const o = passiveStartOptions({ FERAL_MODEL: "feral-local-7b" });
    expect(o.maxTotalCostUsd).toBe(0);
  });
  it("reads a positive cap from the env", () => {
    const o = passiveStartOptions({ FERAL_MODEL: "gpt-4o", FERAL_RSI_MAX_COST_USD: "2.5" });
    expect(o.maxTotalCostUsd).toBe(2.5);
  });
  it("treats a malformed cap as $0 (safe default)", () => {
    const o = passiveStartOptions({ FERAL_MODEL: "x", FERAL_RSI_MAX_COST_USD: "abc" });
    expect(o.maxTotalCostUsd).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd FeralAgent && bun test tests/rsi-passive-supervisor.test.ts`
Expected: FAIL — `o.maxTotalCostUsd` is `undefined`.

- [ ] **Step 3: Add `maxTotalCostUsd` to `PassiveStartOptions` + `passiveStartOptions`**

In `passive-supervisor.ts`, extend the interface (line ~68):

```ts
export interface PassiveStartOptions {
  goal: string;
  maxIterations: number;
  maxTotalTokens: number;
  /** USD spend cap for the passive engine. 0 = local-only (default). */
  maxTotalCostUsd: number;
  concurrency: number;
}
```

And the builder's return (line ~84) — note `costCap` uses `>= 0` so an explicit `0` is honored (unlike `positive`, which rejects 0):

```ts
  const nonNegative = (v: string | undefined, dflt: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  return {
    goal: STANDING_GOAL,
    maxIterations: positive(env.FERAL_RSI_MAX_ITER, 100_000),
    maxTotalTokens: positive(env.FERAL_RSI_MAX_TOKENS, 1_000_000_000),
    maxTotalCostUsd: nonNegative(env.FERAL_RSI_MAX_COST_USD, 0),
    concurrency: Math.max(1, Math.min(4, Math.floor(positive(env.FERAL_RSI_CONCURRENCY, 1)))),
  };
```

- [ ] **Step 4: Add `maxTotalCostUsd` to the sidecar start options type + thread into the engine goal config**

In `sidecar.ts`, find the start-options interface (the one with `maxTotalTokens: number`, line ~68) and add:

```ts
  maxTotalTokens: number;
  /** USD spend cap. 0 = local-only. undefined ⇒ no cost cap (manual runs). */
  maxTotalCostUsd?: number;
```

Then, where the engine `goal` config is built (line ~289), derive the price from the sidecar's own env and pass both fields:

```ts
import { blendedPricePer1kUsd } from "./rsi-cost.ts"; // add near the top imports

// ...inside start(), just before createRsiEngine(...):
const baseUrl = process.env.FERAL_BASE_URL ?? "";
let isLoopback = false;
try {
  const host = new URL(baseUrl).hostname;
  isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
} catch { isLoopback = false; }
const pricePer1kUsd = blendedPricePer1kUsd(process.env.FERAL_MODEL ?? "", isLoopback);

const engine = createRsiEngine({
  seeds,
  goal: {
    goal: opts.goal,
    maxIterations: opts.maxIterations,
    maxTotalTokens: opts.maxTotalTokens,
    ...(opts.maxTotalCostUsd !== undefined ? { maxTotalCostUsd: opts.maxTotalCostUsd } : {}),
    pricePer1kUsd,
  },
  // ...rest unchanged
```

(If `createRsiEngine`'s `goal` parameter is typed as `GoalConfig`, the new optional fields type-check automatically. If it uses a local narrowed type, widen it to include `maxTotalCostUsd?` and `pricePer1kUsd?`.)

- [ ] **Step 5: Run the passive + sidecar suites**

Run: `cd FeralAgent && bun test tests/rsi-passive-supervisor.test.ts && bun test tests/rsi-sidecar.test.ts`
Expected: PASS. Adjust any sidecar test that constructs start-options to include the now-optional `maxTotalCostUsd` only if it asserts exact object shape.

- [ ] **Step 6: Full sidecar suite + typecheck**

Run: `cd FeralAgent && bun test && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add FeralAgent/src/rsi/passive-supervisor.ts FeralAgent/src/rsi/sidecar.ts FeralAgent/tests/rsi-passive-supervisor.test.ts
git commit -m "feat(rsi): thread USD cost cap from env through passive engine"
```

> **Live note:** to see this in the running app, rebuild the sidecar: `cd FeralAgent && bun run build` then copy the produced binary into `src-tauri/binaries/` (per Global Constraints). Not needed for tests.

---

## Task 5: Rust Settings field + command + boot env

**Files:**
- Modify: `src-tauri/src/settings.rs`, `src-tauri/src/lib.rs`
- Test: `src-tauri/src/settings.rs` (inline `#[cfg(test)]`)

**Interfaces:**
- Consumes: nothing.
- Produces: `Settings.rsi_max_cost_usd: Option<f64>` (default `Some(0.0)`); tauri command `set_rsi_budget(budget: Option<f64>)`; env `FERAL_RSI_MAX_COST_USD` exported at boot and on change. Frontend (Task 6) invokes `set_rsi_budget`.

- [ ] **Step 1: Write the failing test (default value)**

Add to the bottom of `settings.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_rsi_budget_is_local_only_zero() {
        let s = Settings::default();
        assert_eq!(s.rsi_max_cost_usd, Some(0.0));
    }
}
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd src-tauri && cargo test --lib settings::tests::default_rsi_budget_is_local_only_zero`
Expected: FAIL — no field `rsi_max_cost_usd`.

- [ ] **Step 3: Add the field to `Settings` + `Default`**

In `settings.rs`, after `token_budget_conversation` (line ~34):

```rust
    /// USD spend cap for the passive RSI background engine, exported to the
    /// sidecar as `FERAL_RSI_MAX_COST_USD`. `Some(0.0)` (default) = local-only:
    /// the free loopback engine runs forever, any paid cloud spend halts. A
    /// positive value allows bounded cloud spend. `None` = no cap (advanced).
    #[serde(default = "default_rsi_budget")]
    pub rsi_max_cost_usd: Option<f64>,
```

Add the default fn (above `impl Default`):

```rust
fn default_rsi_budget() -> Option<f64> { Some(0.0) }
```

And in `Default::default()` (line ~47):

```rust
            token_budget_conversation: None,
            rsi_max_cost_usd: Some(0.0),
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd src-tauri && cargo test --lib settings::tests::default_rsi_budget_is_local_only_zero`
Expected: PASS.

- [ ] **Step 5: Add the `set_rsi_budget` command in `lib.rs`**

Mirror `set_token_budget_conversation` (line ~1517). Add after it:

```rust
/// Set the USD spend cap for the passive RSI background engine.
///
/// `budget = Some(0.0)` (default) → local-only: free local runs continue, any
/// paid cloud spend halts. `Some(n)` → allow up to $n of cloud spend. `None` →
/// no cap. Exports `FERAL_RSI_MAX_COST_USD` and restarts the sidecar so the
/// passive supervisor re-reads it.
#[tauri::command]
#[specta::specta]
fn set_rsi_budget(
    budget: Option<f64>,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let mut s = settings::load();
    s.rsi_max_cost_usd = budget;
    settings::save(&s).map_err(|e| e.to_string())?;

    match budget {
        Some(n) => std::env::set_var("FERAL_RSI_MAX_COST_USD", n.to_string()),
        None => std::env::remove_var("FERAL_RSI_MAX_COST_USD"),
    }
    restart_sidecar(&state);
    Ok(())
}
```

- [ ] **Step 6: Register the command + export env at boot**

6a. Add `set_rsi_budget` to the `tauri::generate_handler!`/`collect_commands!` list next to `set_token_budget_conversation` (line ~2461).

6b. In the boot env block, after the token-budget match (line ~2658), add:

```rust
            // RSI background spend cap. Some(0.0)/default = local-only; Some(n)
            // = allow $n cloud spend; None = no cap (remove the var).
            match cfg.rsi_max_cost_usd {
                Some(n) => std::env::set_var("FERAL_RSI_MAX_COST_USD", n.to_string()),
                None => std::env::remove_var("FERAL_RSI_MAX_COST_USD"),
            }
```

- [ ] **Step 7: Build + test**

Run: `cd src-tauri && cargo build --lib && cargo test --lib settings::`
Expected: PASS. (Building regenerates the tauri-specta TS bindings if the build hook is enabled; if not, Task 6 adds the binding by hand.)

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/settings.rs src-tauri/src/lib.rs
git commit -m "feat(settings): rsi_max_cost_usd USD cap + set_rsi_budget command"
```

---

## Task 6: Frontend Settings plumbing + UI control

**Files:**
- Modify: `frontend-react/src/lib/tauri/index.ts`, `frontend-react/src/stores/settings.ts`, `frontend-react/src/components/settings/AgentSettingsTab.tsx`
- Test: `frontend-react/src/stores/__tests__/settings.test.ts` (extend)

**Interfaces:**
- Consumes: `set_rsi_budget` command (Task 5).
- Produces: `settings.setRsiBudget(budget: number | null)`; `Settings.rsi_max_cost_usd: number | null`; an `RsiBudgetControl` rendered in `AgentSettingsTab`.

- [ ] **Step 1: Write the failing store test**

Extend `settings.test.ts`. Add `rsi_max_cost_usd: 0` to the mock settings object (next to `token_budget_conversation: null`, line ~36), and add:

```ts
it("setRsiBudget persists via the tauri command and updates state", async () => {
  const spy = vi.spyOn(tauri.settings, "setRsiBudget").mockResolvedValue(undefined);
  await useSettings.getState().setRsiBudget(2.5);
  expect(spy).toHaveBeenCalledWith(2.5);
  expect(useSettings.getState().settings?.rsi_max_cost_usd).toBe(2.5);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd frontend-react && npx vitest run src/stores/__tests__/settings.test.ts`
Expected: FAIL — `tauri.settings.setRsiBudget` / `setRsiBudget` undefined.

- [ ] **Step 3: Add the type + tauri bindings in `index.ts`**

3a. Add to the `Settings` interface (after `token_budget_conversation`, line ~179):

```ts
  rsi_max_cost_usd: number | null;
```

3b. Add to `raw` (after `setTokenBudgetConversation`, line ~393):

```ts
  setRsiBudget: (budget: number | null) =>
    invoke<void>('set_rsi_budget', { budget }),
```

3c. Add to the `settings` wrapper (after `setTokenBudget`, line ~522):

```ts
    setRsiBudget: async (budget: number | null) => raw.setRsiBudget(budget),
```

- [ ] **Step 4: Add the store action in `stores/settings.ts`**

Mirror `setTokenBudget` (line ~107). Add to the `SettingsStore` interface and the implementation:

```ts
  setRsiBudget: async (budget) => {
    const prev = get().settings;
    set((s) => s.settings ? { settings: { ...s.settings, rsi_max_cost_usd: budget } } : {});
    try {
      await tauri.settings.setRsiBudget(budget);
    } catch (e) {
      console.error('setRsiBudget failed', e);
      if (prev) set({ settings: { ...prev } });
      throw e;
    }
  },
```

Add `setRsiBudget: (budget: number | null) => Promise<void>;` to the `SettingsStore` interface (near `setTokenBudget`, line ~22 region).

- [ ] **Step 5: Run the store test to confirm it passes**

Run: `cd frontend-react && npx vitest run src/stores/__tests__/settings.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the `RsiBudgetControl` UI in `AgentSettingsTab.tsx`**

Render `<RsiBudgetControl />` next to `<TokenBudgetToggle />` (line ~52), and add the component (mirrors `TokenBudgetToggle`, USD presets, copy explains local=free):

```tsx
/**
 * USD spend cap for the passive RSI background engine. Default $0 = local-only:
 * the free local engine self-improves forever and never spends; any paid cloud
 * spend halts. Raise it to allow bounded cloud spend.
 */
function RsiBudgetControl() {
  const settings    = useSettings((s) => s.settings);
  const setRsiBudget = useSettings((s) => s.setRsiBudget);
  const [busy, setBusy] = useState(false);

  const budget = settings?.rsi_max_cost_usd ?? 0;

  const PRESETS = [
    { label: 'Local only ($0)', value: 0 },
    { label: '$1',  value: 1 },
    { label: '$5',  value: 5 },
    { label: '$20', value: 20 },
  ] as const;

  const setPreset = async (value: number) => {
    if (busy || !settings) return;
    setBusy(true);
    try { await setRsiBudget(value); } catch { /* rolled back */ } finally { setBusy(false); }
  };

  return (
    <div className="rounded-md border border-border-subtle bg-bg-surface p-4 space-y-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-text-primary">Background self-improvement budget</p>
        <p className="text-xs text-text-muted mt-0.5">
          Feral quietly improves itself in the background. Local models are free —
          this caps what it may spend on <span className="text-text-secondary">paid cloud models</span>.
          <span className="text-text-secondary"> $0 = never spend cloud money.</span>
        </p>
      </div>
      <div className="flex gap-1 rounded-md border border-border-subtle p-1">
        {PRESETS.map(({ label, value }) => (
          <button
            key={value}
            type="button"
            disabled={busy || !settings}
            onClick={() => void setPreset(value)}
            className={cn(
              'flex-1 px-2 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50',
              budget === value ? 'bg-brand text-white' : 'text-text-secondary hover:bg-bg-hover',
            )}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Typecheck + full frontend suite**

Run: `cd frontend-react && npm run typecheck && npx vitest run`
Expected: PASS. Update any other test that builds a full `Settings` mock to include `rsi_max_cost_usd: 0` (e.g. `HardwareTab.test.tsx`, `inferParams.test.ts`).

- [ ] **Step 8: Commit**

```bash
git add frontend-react/src/lib/tauri/index.ts frontend-react/src/stores/settings.ts frontend-react/src/components/settings/AgentSettingsTab.tsx frontend-react/src/stores/__tests__/settings.test.ts
git commit -m "feat(settings): RSI background budget USD control in Settings"
```

---

## Task 7: Rename Memory Graph → Memory Layers (rendering unchanged)

This task renames only; the existing `vis-network` rendering still works so the app is shippable between here and Task 10.

**Files:**
- Rename: `frontend-react/src/pages/MemoryGraphPage.tsx` → `MemoryLayersPage.tsx`
- Modify: `frontend-react/src/router.tsx`, `frontend-react/src/components/layout/Sidebar.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: route `/memory-layers` (component `MemoryLayersPage`), redirect from `/memory-graph`, sidebar label "Memory Layers" with action `memoryLayers`.

- [ ] **Step 1: Rename the file + component**

```bash
git mv frontend-react/src/pages/MemoryGraphPage.tsx frontend-react/src/pages/MemoryLayersPage.tsx
```

In the file, rename the export `export function MemoryGraphPage()` → `export function MemoryLayersPage()`. Change the panel title text `Memory Graph` (line ~238) → `Memory Layers`.

- [ ] **Step 2: Update the router**

In `router.tsx`: rename the lazy import (line ~14) to `MemoryLayersPage` importing from `@/pages/MemoryLayersPage`; change the route path `memory-graph` → `memory-layers` (line ~33); add a redirect so old links work:

```tsx
const MemoryLayersPage = lazy(() => import('@/pages/MemoryLayersPage').then((m) => ({ default: m.MemoryLayersPage })));
// ...
{ path: 'memory-layers', element: lazyPage(<MemoryLayersPage />) },
{ path: 'memory-graph', element: <Navigate to="/memory-layers" replace /> },
```

- [ ] **Step 3: Update the sidebar nav item**

In `Sidebar.tsx`: line ~47 — label `Memory Graph` → `Memory Layers`, `action: 'memoryGraph'` → `action: 'memoryLayers'`, `route: '/memory-graph'` → `route: '/memory-layers'`. Update the `MenuAction` union member `'memoryGraph'` → `'memoryLayers'`. Update any `switch`/handler that matches `'memoryGraph'` to `'memoryLayers'` (search the file).

- [ ] **Step 4: Typecheck + suite + grep for stragglers**

Run: `cd frontend-react && npm run typecheck && npx vitest run`
Then: `git grep -n "memoryGraph\|MemoryGraphPage\|/memory-graph" frontend-react/src` — expect only the redirect route to remain.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(memory): rename Memory Graph tab to Memory Layers (+redirect)"
```

---

## Task 8: WebGL2 Mandelbrot renderer + canvas

**Files:**
- Create: `frontend-react/src/lib/fractal/mandelbrot.ts`, `frontend-react/src/components/memory/MandelbrotCanvas.tsx`
- Test: `frontend-react/src/lib/fractal/__tests__/mandelbrot.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type View = { centerX: number; centerY: number; scale: number }` (scale = complex-units per pixel-height-half; smaller = deeper zoom).
  - `screenToComplex(px, py, width, height, view): { x: number; y: number }`.
  - `complexToScreen(x, y, width, height, view): { px: number; py: number }` (inverse).
  - `SEAHORSE_VIEW: View` (opens at `centerX:-0.745, centerY:0.113`).
  - `createMandelbrotRenderer(canvas, opts): { render(view, theme): void; dispose(): void } | null` (null if WebGL2 unavailable).
  - React `MandelbrotCanvas` rendering the canvas, owning user zoom/pan + the shared `view` (lifted via props for Task 10).

- [ ] **Step 1: Write the failing test (pure projection math)**

```ts
// frontend-react/src/lib/fractal/__tests__/mandelbrot.test.ts
import { describe, it, expect } from 'vitest';
import { screenToComplex, complexToScreen, SEAHORSE_VIEW } from '@/lib/fractal/mandelbrot';

describe('mandelbrot projection', () => {
  const W = 800, H = 600;
  it('screen center maps to the view center', () => {
    const c = screenToComplex(W / 2, H / 2, W, H, SEAHORSE_VIEW);
    expect(c.x).toBeCloseTo(SEAHORSE_VIEW.centerX, 6);
    expect(c.y).toBeCloseTo(SEAHORSE_VIEW.centerY, 6);
  });
  it('complexToScreen is the inverse of screenToComplex', () => {
    const view = { centerX: -0.5, centerY: 0.2, scale: 0.004 };
    const back = complexToScreen(
      ...(Object.values(screenToComplex(123, 456, W, H, view)) as [number, number]),
      W, H, view,
    );
    expect(back.px).toBeCloseTo(123, 4);
    expect(back.py).toBeCloseTo(456, 4);
  });
  it('zooming in (smaller scale) shrinks the complex span', () => {
    const wide = screenToComplex(0, H / 2, W, H, { centerX: 0, centerY: 0, scale: 0.01 });
    const deep = screenToComplex(0, H / 2, W, H, { centerX: 0, centerY: 0, scale: 0.001 });
    expect(Math.abs(deep.x)).toBeLessThan(Math.abs(wide.x));
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd frontend-react && npx vitest run src/lib/fractal/__tests__/mandelbrot.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `mandelbrot.ts`**

```ts
// frontend-react/src/lib/fractal/mandelbrot.ts
/**
 * Raw WebGL2 Mandelbrot renderer with smooth (normalized) iteration coloring.
 * Resolution-independent: the fragment shader recomputes z→z²+c per pixel at
 * the current view every draw, so zoom never pixelates. NO animation — the
 * caller draws only in response to user input (wheel/drag/reset).
 */

export interface View {
  centerX: number;   // complex-plane center (real)
  centerY: number;   // complex-plane center (imag)
  scale: number;     // complex units per HALF the canvas height (smaller = deeper)
}

export type FractalTheme = 'light' | 'dark';

/** Opening region: Seahorse Valley (matches the light reference). */
export const SEAHORSE_VIEW: View = { centerX: -0.745, centerY: 0.113, scale: 0.9 };
export const ELEPHANT_VIEW: View = { centerX: 0.275, centerY: 0.007, scale: 0.15 };
export const MINIBROT_VIEW: View = { centerX: -0.7451, centerY: 0.1132, scale: 0.0008 };

/** Pixel (px,py) → complex coordinate, preserving aspect ratio. Origin px=0,py=0
 *  is top-left; the imaginary axis points up (py increases downward). */
export function screenToComplex(px: number, py: number, width: number, height: number, v: View) {
  const aspect = width / height;
  const nx = (px / width) * 2 - 1;        // -1..1 across width
  const ny = (py / height) * 2 - 1;       // -1..1 down height
  return {
    x: v.centerX + nx * v.scale * aspect,
    y: v.centerY - ny * v.scale,          // flip so up = +imag
  };
}

/** Inverse of screenToComplex. */
export function complexToScreen(x: number, y: number, width: number, height: number, v: View) {
  const aspect = width / height;
  const nx = (x - v.centerX) / (v.scale * aspect);
  const ny = -(y - v.centerY) / v.scale;
  return {
    px: ((nx + 1) / 2) * width,
    py: ((ny + 1) / 2) * height,
  };
}

const VERT = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

// Smooth-iteration Mandelbrot. Palette chosen by u_theme (0=light,1=dark).
const FRAG = `#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2  u_res;      // canvas pixels
uniform vec2  u_center;   // complex center
uniform float u_scale;    // complex units per half-height
uniform int   u_theme;    // 0 light, 1 dark
uniform int   u_maxIter;

vec3 lightPalette(float t) {
  // near-white lavender field → blue-violet → periwinkle filigree
  vec3 field  = vec3(0.918, 0.910, 0.949);
  vec3 violet = vec3(0.357, 0.373, 0.682);
  vec3 peri   = vec3(0.604, 0.627, 0.878);
  vec3 c = mix(field, peri, smoothstep(0.0, 0.5, t));
  c = mix(c, violet, smoothstep(0.4, 1.0, t));
  return c;
}
vec3 darkPalette(float t) {
  // black → deep red → orange → amber → cream ember (Feral brand)
  vec3 red    = vec3(0.45, 0.06, 0.03);
  vec3 orange = vec3(0.92, 0.45, 0.06);
  vec3 amber  = vec3(1.00, 0.72, 0.25);
  vec3 cream  = vec3(1.00, 0.96, 0.86);
  vec3 c = mix(red, orange, smoothstep(0.0, 0.45, t));
  c = mix(c, amber, smoothstep(0.4, 0.8, t));
  c = mix(c, cream, smoothstep(0.85, 1.0, t));
  return c;
}

void main() {
  float aspect = u_res.x / u_res.y;
  vec2 ndc = (gl_FragCoord.xy / u_res) * 2.0 - 1.0;   // -1..1
  vec2 c = u_center + vec2(ndc.x * u_scale * aspect, ndc.y * u_scale);

  vec2 z = vec2(0.0);
  int i = 0;
  const float BAIL = 256.0;
  for (int n = 0; n < 2048; n++) {
    if (n >= u_maxIter) break;
    z = vec2(z.x*z.x - z.y*z.y, 2.0*z.x*z.y) + c;
    if (dot(z, z) > BAIL) break;
    i++;
  }

  vec3 interior = (u_theme == 1) ? vec3(0.02, 0.02, 0.03) : vec3(0.05, 0.05, 0.09);
  if (i >= u_maxIter) { outColor = vec4(interior, 1.0); return; }

  // Normalized (smooth) iteration count.
  float mu = float(i) + 1.0 - log2(log2(dot(z, z)) * 0.5);
  float t = clamp(mu / float(u_maxIter), 0.0, 1.0);
  t = pow(t, 0.5); // perceptual lift so detail near the boundary reads

  vec3 col = (u_theme == 1) ? darkPalette(t) : lightPalette(t);
  outColor = vec4(col, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error('shader compile failed:', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

export interface MandelbrotRenderer {
  render(view: View, theme: FractalTheme): void;
  resize(): void;
  dispose(): void;
}

/** Create the renderer, or null if WebGL2 isn't available (caller shows a
 *  static fallback). The caller owns the draw cadence — there is no loop. */
export function createMandelbrotRenderer(canvas: HTMLCanvasElement): MandelbrotRenderer | null {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
  if (!gl) return null;

  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return null;
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('program link failed:', gl.getProgramInfoLog(prog));
    return null;
  }

  // Fullscreen triangle.
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const u_res = gl.getUniformLocation(prog, 'u_res');
  const u_center = gl.getUniformLocation(prog, 'u_center');
  const u_scale = gl.getUniformLocation(prog, 'u_scale');
  const u_theme = gl.getUniformLocation(prog, 'u_theme');
  const u_maxIter = gl.getUniformLocation(prog, 'u_maxIter');

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
  };

  const render = (view: View, theme: FractalTheme) => {
    resize();
    gl.useProgram(prog);
    gl.uniform2f(u_res, canvas.width, canvas.height);
    gl.uniform2f(u_center, view.centerX, view.centerY);
    gl.uniform1f(u_scale, view.scale);
    gl.uniform1i(u_theme, theme === 'dark' ? 1 : 0);
    // More iterations as we zoom in (deeper detail) — bounded by the loop cap.
    const iter = Math.min(2048, Math.floor(120 + 60 * Math.log2(1 / Math.max(view.scale, 1e-7))));
    gl.uniform1i(u_maxIter, Math.max(120, iter));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  return {
    render,
    resize,
    dispose() {
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buf);
    },
  };
}
```

- [ ] **Step 4: Run the projection test to confirm it passes**

Run: `cd frontend-react && npx vitest run src/lib/fractal/__tests__/mandelbrot.test.ts`
Expected: PASS (3 tests). (WebGL itself isn't exercised in jsdom; the pure math is.)

- [ ] **Step 5: Implement `MandelbrotCanvas.tsx`**

```tsx
// frontend-react/src/components/memory/MandelbrotCanvas.tsx
import { useEffect, useRef } from 'react';
import {
  createMandelbrotRenderer, screenToComplex,
  type View, type FractalTheme, type MandelbrotRenderer,
} from '@/lib/fractal/mandelbrot';

interface Props {
  view: View;
  theme: FractalTheme;
  /** User changed the view (wheel/drag). Parent owns the View (shared with nodes). */
  onViewChange: (v: View) => void;
}

const MIN_SCALE = 1e-6;   // fp32 deep-zoom floor
const MAX_SCALE = 2.0;    // fully zoomed out

/**
 * WebGL2 Mandelbrot backdrop. Fully user-driven: wheel zooms toward the cursor,
 * drag pans. No animation loop — we redraw only when `view`/`theme` change or
 * the user interacts. Falls back to a flat field if WebGL2 is unavailable.
 */
export function MandelbrotCanvas({ view, theme, onViewChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<MandelbrotRenderer | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  // Create the renderer once.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const r = createMandelbrotRenderer(canvas);
    rendererRef.current = r;
    if (!r) return; // fallback handled by CSS background below
    const onResize = () => { r.render(viewRef.current, theme); };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      r.dispose();
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Redraw on view/theme change.
  useEffect(() => {
    rendererRef.current?.render(view, theme);
  }, [view, theme]);

  // Wheel zoom toward cursor.
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const before = screenToComplex(px, py, rect.width, rect.height, viewRef.current);
    const factor = e.deltaY > 0 ? 1.1 : 1 / 1.1;
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, viewRef.current.scale * factor));
    const v2: View = { ...viewRef.current, scale };
    const after = screenToComplex(px, py, rect.width, rect.height, v2);
    // Keep the point under the cursor fixed.
    onViewChange({
      centerX: v2.centerX + (before.x - after.x),
      centerY: v2.centerY + (before.y - after.y),
      scale,
    });
  };

  // Drag pan.
  const drag = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const aspect = rect.width / rect.height;
    const dxPix = e.clientX - drag.current.x;
    const dyPix = e.clientY - drag.current.y;
    drag.current = { x: e.clientX, y: e.clientY };
    // Convert pixel delta to complex delta (note the +imag-up flip).
    const v = viewRef.current;
    onViewChange({
      centerX: v.centerX - (dxPix / rect.width) * 2 * v.scale * aspect,
      centerY: v.centerY + (dyPix / rect.height) * 2 * v.scale,
      scale: v.scale,
    });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    drag.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  };

  // CSS fallback color = flat field if WebGL2 missing (renderer null).
  const fallbackBg = theme === 'dark' ? '#050508' : '#eae8f2';

  return (
    <canvas
      ref={canvasRef}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      className="fixed inset-0 z-0 h-full w-full touch-none cursor-grab active:cursor-grabbing"
      style={{ background: fallbackBg }}
    />
  );
}
```

- [ ] **Step 6: Typecheck**

Run: `cd frontend-react && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend-react/src/lib/fractal/mandelbrot.ts frontend-react/src/components/memory/MandelbrotCanvas.tsx frontend-react/src/lib/fractal/__tests__/mandelbrot.test.ts
git commit -m "feat(memory): WebGL2 Mandelbrot renderer + user-driven canvas"
```

---

## Task 9: Seeded node layout + vector node overlay

**Files:**
- Create: `frontend-react/src/lib/fractal/layout.ts`, `frontend-react/src/components/memory/NodeOverlay.tsx`
- Test: `frontend-react/src/lib/fractal/__tests__/layout.test.ts`

**Interfaces:**
- Consumes: `MemoryGraphSnapshot` (`@/lib/tauri`), `View`/`complexToScreen` (Task 8).
- Produces:
  - `type LaidOutNode = { id: string; label: string; type: string; wx: number; wy: number; degree: number }` (wx/wy = complex-plane world coords).
  - `layoutNodes(snapshot): LaidOutNode[]` — deterministic for a given snapshot (seeded; no randomness, no per-frame physics).
  - `NodeOverlay` React component: Canvas2D vector draw + hit-testing + LOD, sharing `view` with the fractal.

- [ ] **Step 1: Write the failing test (determinism + degree)**

```ts
// frontend-react/src/lib/fractal/__tests__/layout.test.ts
import { describe, it, expect } from 'vitest';
import { layoutNodes } from '@/lib/fractal/layout';
import type { MemoryGraphSnapshot } from '@/lib/tauri';

const snap: MemoryGraphSnapshot = {
  nodes: [
    { id: 'a', label: 'A', type: 'entity', touched_at: 1 },
    { id: 'b', label: 'B', type: 'concept', touched_at: 2 },
    { id: 'c', label: 'C', type: 'fact', touched_at: 3 },
  ],
  edges: [
    { from: 'a', to: 'b', relation: 'rel' },
    { from: 'a', to: 'c', relation: 'rel' },
  ],
};

describe('layoutNodes', () => {
  it('is deterministic for the same snapshot', () => {
    const a = layoutNodes(snap);
    const b = layoutNodes(snap);
    expect(a).toEqual(b);
  });
  it('positions every node and computes degree', () => {
    const out = layoutNodes(snap);
    expect(out).toHaveLength(3);
    expect(out.find((n) => n.id === 'a')!.degree).toBe(2);
    expect(out.find((n) => n.id === 'b')!.degree).toBe(1);
    for (const n of out) {
      expect(Number.isFinite(n.wx)).toBe(true);
      expect(Number.isFinite(n.wy)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd frontend-react && npx vitest run src/lib/fractal/__tests__/layout.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `layout.ts`**

```ts
// frontend-react/src/lib/fractal/layout.ts
import type { MemoryGraphSnapshot } from '@/lib/tauri';

export interface LaidOutNode {
  id: string;
  label: string;
  type: string;
  wx: number;   // world (complex-plane) x
  wy: number;   // world (complex-plane) y
  degree: number;
}

/** Deterministic string hash (FNV-1a) → seeds per-node placement so the layout
 *  is stable across reloads (no randomness, no physics). */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0xffffffff; // 0..1
}

/**
 * Place nodes on a deterministic phyllotaxis (sunflower) spiral around the
 * opening region, jittered by a per-id hash. Phyllotaxis spreads points evenly
 * with no clumping and reads naturally against the fractal's own spirals.
 * Coordinates are in the complex plane so they zoom 1:1 with the fractal.
 */
export function layoutNodes(snapshot: MemoryGraphSnapshot): LaidOutNode[] {
  const degree = new Map<string, number>();
  for (const e of snapshot.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const GOLDEN = Math.PI * (3 - Math.sqrt(5)); // golden angle
  const SPREAD = 0.6;       // complex-plane radius of the cloud
  const CENTER_X = -0.745;  // Seahorse Valley (matches the opening view)
  const CENTER_Y = 0.113;
  const n = snapshot.nodes.length;
  return snapshot.nodes.map((node, i) => {
    const r = SPREAD * Math.sqrt((i + 0.5) / Math.max(1, n));
    const theta = i * GOLDEN + hash(node.id) * 0.4; // hash jitter breaks symmetry
    return {
      id: node.id,
      label: node.label,
      type: node.type,
      wx: CENTER_X + r * Math.cos(theta),
      wy: CENTER_Y + r * Math.sin(theta),
      degree: degree.get(node.id) ?? 0,
    };
  });
}
```

- [ ] **Step 4: Run the layout test to confirm it passes**

Run: `cd frontend-react && npx vitest run src/lib/fractal/__tests__/layout.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Implement `NodeOverlay.tsx`** (Canvas2D vector glows, DPR-aware, hit-testing, LOD)

```tsx
// frontend-react/src/components/memory/NodeOverlay.tsx
import { useEffect, useMemo, useRef } from 'react';
import type { MemoryGraphSnapshot } from '@/lib/tauri';
import { complexToScreen, type View } from '@/lib/fractal/mandelbrot';
import { layoutNodes, type LaidOutNode } from '@/lib/fractal/layout';

interface Props {
  snapshot: MemoryGraphSnapshot;
  view: View;
  colorFor: (type: string) => string;   // reuse the page's theme type palette
  hiddenTypes: Set<string>;
  search: string;
  onSelect: (id: string | null) => void;
}

/** Hit radius in px around a node center for click selection. */
const HIT_PX = 14;

/**
 * Vector node/edge layer drawn on a 2D canvas above the fractal. Nodes are glow
 * orbs (size = degree, hue = type); edges are faint links. DPR-aware so it stays
 * crisp at any zoom. LOD: labels + edges fade out when zoomed far out or dense,
 * keeping ~1000+ nodes readable and cheap (one draw per view change, no physics).
 */
export function NodeOverlay({ snapshot, view, colorFor, hiddenTypes, search, onSelect }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const laidOut = useMemo(() => layoutNodes(snapshot), [snapshot]);
  const byId = useMemo(() => new Map(laidOut.map((n) => [n.id, n] as const)), [laidOut]);
  const q = search.trim().toLowerCase();

  const visible = useMemo<LaidOutNode[]>(
    () => laidOut.filter((n) => !hiddenTypes.has(n.type) && (!q || n.label.toLowerCase().includes(q))),
    [laidOut, hiddenTypes, q],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const visibleSet = new Set(visible.map((n) => n.id));
    const dense = visible.length > 350;
    // LOD: show edges/labels only when not too dense AND zoomed in enough.
    const showEdges = !dense && view.scale < 0.5;
    const showLabels = !dense && view.scale < 0.12;

    if (showEdges) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(148,163,184,0.25)';
      for (const e of snapshot.edges) {
        if (!visibleSet.has(e.from) || !visibleSet.has(e.to)) continue;
        const a = byId.get(e.from)!, b = byId.get(e.to)!;
        const pa = complexToScreen(a.wx, a.wy, w, h, view);
        const pb = complexToScreen(b.wx, b.wy, w, h, view);
        ctx.beginPath();
        ctx.moveTo(pa.px, pa.py);
        ctx.lineTo(pb.px, pb.py);
        ctx.stroke();
      }
    }

    for (const n of visible) {
      const p = complexToScreen(n.wx, n.wy, w, h, view);
      if (p.px < -50 || p.py < -50 || p.px > w + 50 || p.py > h + 50) continue; // cull off-screen
      const radius = 4 + Math.min(n.degree * 1.5, 12);
      const color = colorFor(n.type);
      // Glow
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.px, p.py, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      if (showLabels) {
        ctx.fillStyle = 'rgba(203,213,225,0.95)';
        ctx.font = '11px Inter, system-ui, sans-serif';
        ctx.fillText(n.label, p.px + radius + 3, p.py + 3);
      }
    }
  }, [visible, view, snapshot.edges, byId, colorFor]);

  const onClick = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    let best: { id: string; d: number } | null = null;
    for (const n of visible) {
      const p = complexToScreen(n.wx, n.wy, rect.width, rect.height, view);
      const d = Math.hypot(p.px - px, p.py - py);
      if (d <= HIT_PX && (!best || d < best.d)) best = { id: n.id, d };
    }
    onSelect(best?.id ?? null);
  };

  // pointer-events: none on the canvas would block fractal drag; instead this
  // sits above and forwards drag/wheel by being transparent to them EXCEPT
  // clicks. We let clicks here select; drag/wheel are handled by the fractal
  // canvas below via event bubbling when no node is hit.
  return (
    <canvas
      ref={canvasRef}
      onClick={onClick}
      className="pointer-events-none fixed inset-0 z-[1] h-full w-full"
    />
  );
}
```

> **Interaction note for Task 10:** the overlay canvas is `pointer-events-none` so wheel/drag reach the fractal; node *selection* is handled by a transparent hit-test layer or by lifting the click handler to the page wrapper (Task 10 wires the click via the page container using the same `complexToScreen` hit-test). Keep the hit-test logic exported if needed.

- [ ] **Step 6: Typecheck + both fractal tests**

Run: `cd frontend-react && npm run typecheck && npx vitest run src/lib/fractal`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend-react/src/lib/fractal/layout.ts frontend-react/src/components/memory/NodeOverlay.tsx frontend-react/src/lib/fractal/__tests__/layout.test.ts
git commit -m "feat(memory): seeded node layout + vector node overlay with LOD"
```

---

## Task 10: Compose the fractal page + scale check

**Files:**
- Modify: `frontend-react/src/pages/MemoryLayersPage.tsx`
- Test: `frontend-react/src/pages/__tests__/MemoryLayersPage.test.tsx` (create — smoke)

**Interfaces:**
- Consumes: `MandelbrotCanvas` (Task 8), `NodeOverlay` (Task 9), existing `getGraph()` + chrome.
- Produces: the finished page — fractal backdrop + node overlay + existing control panel, sharing one `view` state, zoomed by the user only.

- [ ] **Step 1: Write the failing smoke test**

```tsx
// frontend-react/src/pages/__tests__/MemoryLayersPage.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryLayersPage } from '@/pages/MemoryLayersPage';
import { tauri } from '@/lib/tauri';

beforeEach(() => {
  vi.spyOn(tauri.memory, 'getGraph').mockResolvedValue({
    nodes: [{ id: 'a', label: 'Alpha', type: 'entity', touched_at: 1 }],
    edges: [],
  });
});

describe('MemoryLayersPage', () => {
  it('renders the control panel title and loads the graph', async () => {
    render(<MemoryLayersPage />);
    expect(await screen.findByText('Memory Layers')).toBeInTheDocument();
    await waitFor(() => expect(tauri.memory.getGraph).toHaveBeenCalled());
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd frontend-react && npx vitest run src/pages/__tests__/MemoryLayersPage.test.tsx`
Expected: FAIL (page still renders vis-network; `getContext('webgl2')` returns null in jsdom — the renderer must degrade gracefully, which is why `createMandelbrotRenderer` returns null and the canvas keeps its CSS fallback). If the test fails because of a `vis-network` import error in jsdom, that confirms the swap is needed.

- [ ] **Step 3: Rewrite `MemoryLayersPage` rendering**

Replace the `vis-network`/`vis-data` imports and the network-building `useEffect` (the whole `Network`/`DataSet` block, `MemoryGraphPage` lines ~1-3 and ~116-220) with the composed fractal scene. Keep ALL existing chrome unchanged: the floating control panel (search, type chips with `typeCounts`, relation chips, node count), the refresh button, the selected-node detail card, and the loading/empty states. Concretely:

- Remove: `import { Network } from 'vis-network';`, `import { DataSet } from 'vis-data';`, `canvasRef`/`networkRef`, and the network `useEffect`.
- Add: `import { MandelbrotCanvas } from '@/components/memory/MandelbrotCanvas';`, `import { NodeOverlay } from '@/components/memory/NodeOverlay';`, `import { SEAHORSE_VIEW, type View } from '@/lib/fractal/mandelbrot';`.
- Add shared view state and theme mapping:

```tsx
const [view, setView] = useState<View>(SEAHORSE_VIEW);
const fractalTheme = resolvedTheme === 'dark' ? 'dark' : 'light';
```

- Replace the old full-bleed `<div ref={canvasRef} .../>` (line ~357) with the scene (backdrop + overlay), keeping it at the same z-layer below the control cards:

```tsx
{!loading && !empty && (
  <>
    <MandelbrotCanvas view={view} theme={fractalTheme} onViewChange={setView} />
    <NodeOverlay
      snapshot={graph!}
      view={view}
      colorFor={colorFor}
      hiddenTypes={hiddenTypes}
      search={search}
      onSelect={(id) => {
        if (!id) { setSelected(null); return; }
        const node = graph!.nodes.find((n) => n.id === id);
        if (!node) return;
        const neighbors: SelectedNode['neighbors'] = [];
        for (const e of graph!.edges) {
          if (e.from === id) {
            const to = graph!.nodes.find((n) => n.id === e.to);
            if (to) neighbors.push({ relation: e.relation, label: to.label, direction: 'out' });
          } else if (e.to === id) {
            const from = graph!.nodes.find((n) => n.id === e.from);
            if (from) neighbors.push({ relation: e.relation, label: from.label, direction: 'in' });
          }
        }
        setSelected({ id: node.id, label: node.label, type: node.type, neighbors });
      }}
    />
  </>
)}
```

- Add a small "Reset view" button near the Refresh button that does `setView(SEAHORSE_VIEW)`.
- Keep `colorFor`, `typeCounts`, `relationCounts`, `visible` (used by chips/counts), `toggleType`, `selected`, etc., exactly as they are.

> **Selection vs drag:** `NodeOverlay` is `pointer-events-none`, so wheel/drag reach the fractal. Wire node selection by adding an `onClick` on the page's root container that runs the same `complexToScreen` hit-test against `layoutNodes(graph)` — or temporarily enable pointer events on the overlay only for `click`. Use the container-level click to avoid blocking drag (a click with no movement selects; a drag pans).

- [ ] **Step 4: Run the smoke test to confirm it passes**

Run: `cd frontend-react && npx vitest run src/pages/__tests__/MemoryLayersPage.test.tsx`
Expected: PASS — title "Memory Layers" present, `getGraph` called, no vis-network import error, WebGL absence degrades to the CSS fallback without throwing.

- [ ] **Step 5: Scale check (synthetic ~1000 nodes) — manual + assert layout cost**

Add a quick perf assertion to `layout.test.ts`:

```ts
it('lays out 1000 nodes quickly and deterministically', () => {
  const big: MemoryGraphSnapshot = {
    nodes: Array.from({ length: 1000 }, (_, i) => ({ id: `n${i}`, label: `N${i}`, type: 'fact', touched_at: i })),
    edges: [],
  };
  const t0 = performance.now();
  const a = layoutNodes(big);
  const ms = performance.now() - t0;
  expect(a).toHaveLength(1000);
  expect(ms).toBeLessThan(50); // pure layout is cheap; no per-frame physics
});
```

Run: `cd frontend-react && npx vitest run src/lib/fractal/__tests__/layout.test.ts`
Expected: PASS. Then verify visually in the running app (see Step 7): zoom in/out stays crisp (no pixelation), labels/edges cull when zoomed out, drag pans, theme switch flips the palette.

- [ ] **Step 6: Full frontend suite + typecheck + build**

Run: `cd frontend-react && npm run typecheck && npx vitest run && npm run build`
Expected: PASS (build confirms `vis-network` is no longer imported by this page; it may now be fully unused — if so, removing it from `package.json` is an optional follow-up, not part of this task).

- [ ] **Step 7: Visual verification in the app**

Rebuild the sidecar if any `FeralAgent` change is being run live (`cd FeralAgent && bun run build` + copy to `src-tauri/binaries/`), then `cargo tauri dev`. Open **Memory Layers**: confirm static-on-load, wheel-zoom toward cursor, drag-pan, reset view, node selection, theme palettes (lavender light / orange-ember dark), and the Settings → Agent → "Background self-improvement budget" control persists.

- [ ] **Step 8: Commit**

```bash
git add frontend-react/src/pages/MemoryLayersPage.tsx frontend-react/src/pages/__tests__/MemoryLayersPage.test.tsx frontend-react/src/lib/fractal/__tests__/layout.test.ts
git commit -m "feat(memory): compose Mandelbrot + node overlay into Memory Layers page"
```

---

## Self-Review (completed during planning)

- **Spec coverage:** RSI UI removal → Task 1. USD budget (settings + enforcement + UI) → Tasks 2–6. Rename → Task 7. WebGL2 Mandelbrot + smooth coloring + user-only zoom/pan + theme palettes → Task 8. Seeded layout + vector nodes + LOD + 1000-node scale → Tasks 9–10. No-auto-motion → enforced in Tasks 8/10 (no animation loop; redraw on input only). `$0`=local-only exact guarantee → Task 2 (`isLoopback`→0) + Task 3 (`costStop`). All spec sections map to a task.
- **Placeholder scan:** none — every code step has complete code; mechanical plumbing references exact existing patterns with line anchors and full snippets.
- **Type consistency:** `View`, `LaidOutNode`, `screenToComplex`/`complexToScreen`, `GoalConfig.maxTotalCostUsd`/`pricePer1kUsd`, `costStop`, `Settings.rsi_max_cost_usd`, `set_rsi_budget`/`setRsiBudget` are named identically across producing and consuming tasks.
