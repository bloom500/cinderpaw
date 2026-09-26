/**
 * The worker-bubble `status` union is declared TWICE — once by the sidecar
 * that emits it (`rlm_child` in `CinderpawAgent/src/types.ts`) and once by
 * the frontend that renders it (`RlmWorkerStatus` in
 * `frontend-react/src/stores/rlmWorkers.ts`, which the WorkersCard draws) —
 * in two packages that never see each other's types. Nothing made them agree.
 *
 * What drift costs here is a mystery bubble, not a lie on screen. The store
 * passes an unknown status straight through (`upsertWorker` translates only
 * `completed` → `done`), the bubble's icon chain (`ToolCallBubble`) matches
 * exactly four statuses, and an unknown one matches none of them: no icon,
 * default border, expandable detail. A worker nobody can read the state of.
 * Less severe than the cowork-kind drift (which rendered failure as success),
 * same road: a sidecar addition the frontend never heard of.
 *
 * Only `rlm_child` needs pinning. Tool-bubble statuses are derived UI-side
 * (`result.ok ? 'done' : 'error'`, `cancelled` concluded locally), and cowork
 * statuses are derived from `eventType` — which already has its own parity
 * test (`cowork-event-parity.test.ts`). The wire is the only place a new
 * status can walk in unannounced, and `rlm_child.status` is the only raw
 * wire status that reaches a bubble.
 *
 * Lives in the sidecar suite on purpose (see cowork-event-parity.test.ts):
 * cross-package contract test, frontend tsconfig has no Node types.
 *
 * Fifth boundary of this discipline after protocol_drift.rs (message types),
 * secret-redaction-cases.json (key formats), rsi-code-patch-denylist-parity
 * (patch denylist) and cowork-event-parity (event kinds).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Statuses the sidecar emits that the frontend does not declare, with
 *  their explicit translation in `upsertWorker` (`stores/chat.ts`). The
 *  test asserts every translation LANDS inside the frontend union, so a
 *  mapping to a status nobody renders fails here instead of on screen. */
// Empty since 26 Sep: the workers store keeps the wire statuses as they are.
const STATUS_TRANSLATIONS: Record<string, string> = {};

/** Pull the string-literal members of the `status` union that immediately
 *  follows `anchor` in a TypeScript source. Deliberately textual — see
 *  cowork-event-parity.test.ts for why the other package is read as a
 *  file rather than imported. */
function statusUnion(source: string, anchor: RegExp, what: string): Set<string> {
  // Comments go first: a `;` inside a `//` comment would truncate the
  // match exactly the way it once did to the cowork-kind parser (which
  // read 6 of 10 kinds and passed). The self-check test below exists so
  // a truncated parse fails loudly instead of guarding nothing.
  const clean = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  const hit = anchor.exec(clean);
  if (!hit) throw new Error(`no ${what} anchor found`);
  const after = clean.slice(hit.index + hit[0].length);
  const field = /status\s*:\s*([\s\S]*?);/.exec(after);
  if (!field) throw new Error(`no status union after the ${what} anchor`);

  const members = field[1].match(/['"]([a-z_]+)['"]/g) ?? [];
  const out = new Set(members.map((m) => m.slice(1, -1)));
  if (out.size === 0) throw new Error(`the ${what} status union parsed as empty`);
  return out;
}

const REPO = join(import.meta.dir, "..", "..");

function sidecarStatuses(): Set<string> {
  return statusUnion(
    readFileSync(join(REPO, "CinderpawAgent", "src", "types.ts"), "utf8"),
    /type:\s*"rlm_child"\s*;/,
    "rlm_child",
  );
}

function frontendStatuses(): Set<string> {
  // A type alias, not a `status:` field, so it is read directly.
  const src = readFileSync(join(REPO, "frontend-react", "src", "stores", "rlmWorkers.ts"), "utf8");
  const alias = /export type RlmWorkerStatus\s*=\s*([^;]*);/.exec(src);
  if (!alias) throw new Error("no RlmWorkerStatus alias found");
  const members = alias[1].match(/['"]([a-z_]+)['"]/g) ?? [];
  return new Set(members.map((m) => m.slice(1, -1)));
}

describe("rlm_child status — sidecar/frontend parity", () => {
  test("every emitted status renders or has an explicit translation", () => {
    const sidecar = sidecarStatuses();
    const frontend = frontendStatuses();

    const unhandled = [...sidecar]
      .filter((s) => !frontend.has(s) && !(s in STATUS_TRANSLATIONS))
      .sort();
    expect(
      unhandled,
      "the sidecar emits these worker statuses and the frontend renders none of " +
        "them — each one currently draws a bubble with no icon and no state the " +
        "user can read. Add the icon in ToolCallBubble.tsx AND the status to " +
        "the worker member of ToolCallEvent in stores/chat.ts",
    ).toEqual([]);

    // The translations themselves must land somewhere real on both ends.
    for (const [from, to] of Object.entries(STATUS_TRANSLATIONS)) {
      expect(sidecar.has(from), `translation source '${from}' is not emitted anymore`).toBe(true);
      expect(frontend.has(to), `translation target '${to}' is not rendered anymore`).toBe(true);
    }
  });

  test("the parser actually finds the unions rather than passing on drift", () => {
    // A parity test that silently matched truncated sets would pass forever
    // while guarding nothing. Pin a known member and the current size on
    // each side; any parser rot or union edit trips these first.
    const sidecar = sidecarStatuses();
    expect(sidecar.has("running")).toBe(true);
    expect(sidecar.has("completed")).toBe(true);
    expect(sidecar.size).toBe(4);

    const frontend = frontendStatuses();
    expect(frontend.has("running")).toBe(true);
    expect(frontend.has("completed")).toBe(true);
    expect(frontend.size).toBe(4);
  });
});
