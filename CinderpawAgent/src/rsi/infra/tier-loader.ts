/**
 * Faza 1 — runEval real: the Tier 1/2 on-disk spec loader.
 *
 * Tier 0 is frozen in Rust (`rsi_get_tier0_specs`). Tier 1 and Tier 2
 * are file-based: one JSON file per task under `eval/tier1/` and
 * `eval/tier2/`. This loader reads them at boot and turns them into the
 * same `EvalSpec` shape the validator consumes.
 *
 * It is deliberately strict. A malformed or partial spec on disk throws
 * (naming the offending file) rather than being skipped — a silently
 * dropped task would make the suite easier and inflate the eval-gate
 * score, defeating the whole point of the gate. Specs are returned
 * id-sorted so a run is reproducible regardless of filesystem ordering.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type EvalExpected,
  type EvalKind,
  type EvalSpec,
} from "./eval-spec.ts";

const KINDS: readonly EvalKind[] = [
  "json_format",
  "fact_lookup",
  "token_budget",
  "latency",
  "tool_call",
];

/** Load every `*.json` spec in `dir`, id-sorted. Missing dir → []. */
export function loadTierSpecs(dir: string): EvalSpec[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const specs = files.map((file) => parseSpec(dir, file));
  return specs.sort((a, b) => a.id.localeCompare(b.id));
}

function parseSpec(dir: string, file: string): EvalSpec {
  const path = join(dir, file);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(
      `tier-loader: invalid JSON in '${file}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`tier-loader: '${file}' is not a spec object`);
  }
  const o = raw as Record<string, unknown>;

  requireString(o, "id", file);
  requireString(o, "name", file);
  requireString(o, "description", file);
  requireString(o, "prompt", file);
  if (typeof o.tier !== "number") {
    throw new Error(`tier-loader: '${file}' field 'tier' must be a number`);
  }
  if (typeof o.kind !== "string" || !KINDS.includes(o.kind as EvalKind)) {
    throw new Error(
      `tier-loader: '${file}' field 'kind' must be one of ${KINDS.join(", ")}`,
    );
  }
  const expected = validateExpected(o.kind as EvalKind, o.expected, file);

  return {
    id: o.id as string,
    tier: o.tier,
    name: o.name as string,
    description: o.description as string,
    prompt: o.prompt as string,
    kind: o.kind as EvalKind,
    expected,
  };
}

function requireString(o: Record<string, unknown>, key: string, file: string) {
  if (typeof o[key] !== "string" || (o[key] as string).length === 0) {
    throw new Error(`tier-loader: '${file}' field '${key}' must be a non-empty string`);
  }
}

function validateExpected(
  kind: EvalKind,
  expected: unknown,
  file: string,
): EvalExpected {
  if (expected === null || typeof expected !== "object") {
    throw new Error(`tier-loader: '${file}' field 'expected' must be an object`);
  }
  const e = expected as Record<string, unknown>;
  if (e.type !== kind) {
    throw new Error(
      `tier-loader: '${file}' kind '${kind}' disagrees with expected.type '${String(e.type)}'`,
    );
  }
  switch (kind) {
    case "json_format":
      if (!Array.isArray(e.required_keys) || !e.required_keys.every((k) => typeof k === "string")) {
        throw new Error(`tier-loader: '${file}' json_format needs string[] required_keys`);
      }
      return { type: "json_format", required_keys: e.required_keys as string[] };
    case "fact_lookup":
      if (typeof e.answer !== "string") {
        throw new Error(`tier-loader: '${file}' fact_lookup needs string answer`);
      }
      return { type: "fact_lookup", answer: e.answer };
    case "token_budget":
      if (typeof e.max_tokens !== "number") {
        throw new Error(`tier-loader: '${file}' token_budget needs number max_tokens`);
      }
      return { type: "token_budget", max_tokens: e.max_tokens };
    case "latency":
      if (typeof e.max_ms !== "number") {
        throw new Error(`tier-loader: '${file}' latency needs number max_ms`);
      }
      return { type: "latency", max_ms: e.max_ms };
    case "tool_call": {
      if (typeof e.tool !== "string" || e.tool.length === 0) {
        throw new Error(`tier-loader: '${file}' tool_call needs string tool`);
      }
      if (!Array.isArray(e.required_args) || !e.required_args.every((k) => typeof k === "string")) {
        throw new Error(`tier-loader: '${file}' tool_call needs string[] required_args`);
      }
      const pins = e.arg_equals;
      if (pins !== undefined) {
        if (pins === null || typeof pins !== "object" || Array.isArray(pins) ||
            !Object.values(pins).every((v) => typeof v === "string")) {
          throw new Error(`tier-loader: '${file}' tool_call arg_equals must map string→string`);
        }
      }
      return {
        type: "tool_call",
        tool: e.tool,
        required_args: e.required_args as string[],
        ...(pins !== undefined ? { arg_equals: pins as Record<string, string> } : {}),
      };
    }
  }
}
