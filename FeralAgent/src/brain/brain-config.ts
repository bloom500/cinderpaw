/**
 * Brain config loader — Brain Stack slice 5.
 *
 * Reads `~/.feral/brain.json` (or `$FERAL_HOME/brain.json`) and returns a
 * `BrainConfig`. Opt-in: when the file is absent, Brain Stack stays
 * disabled and the agent-loop falls through to the existing path
 * (`router.complete()` with `#primary` / `#fallback`).
 *
 * Env escape hatch for headless testing:
 *   - `FERAL_BRAIN=1` forces enable. If brain.json is missing, we throw
 *     (explicit "I asked for brain mode but there's no config"); if it
 *     is present, its `enabled` flag is forced to true regardless.
 *   - Without `FERAL_BRAIN`, brain.json presence is the opt-in signal.
 *     The file's `enabled` flag determines whether Brain is actually on
 *     (allows a user to ship brain.json with `enabled: false` to
 *     pre-stage config without turning it on).
 *
 * Validates the loaded JSON shape minimally:
 *   - `enabled` must be a boolean
 *   - `mode` must be "budget" | "balanced" | "quality"
 *   - `registry` must be an array (BrainStack throws on duplicate ids;
 *     we don't pre-validate that here)
 * Throws on any violation — a malformed brain.json is a config bug, not
 * a runtime condition to paper over.
 *
 * The loader is a pure function on the filesystem + env. It does NOT
 * build a `BrainStack` — that's the caller's job, after the config is
 * in hand. Decoupling keeps this module testable without standing up
 * the rest of the brain stack.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { BrainConfig } from "./brain-stack.ts";
import type { Mode } from "./brain-stack.ts";

const VALID_MODES: ReadonlySet<Mode> = new Set<Mode>([
  "budget",
  "balanced",
  "quality",
]);

/**
 * Default location for brain.json: `$FERAL_HOME/brain.json` if set,
 * else `~/.feral/brain.json`. Exported so callers (and tests) can
 * discover the same path the loader would use.
 */
export function defaultBrainPath(): string {
  const feralHome = process.env.FERAL_HOME ?? join(homedir(), ".feral");
  return join(feralHome, "brain.json");
}

/** Options for {@link loadBrainConfig}. Tests pass `brainPath` to point
 *  at a temp file; production code uses the default. `env` overrides
 *  `process.env` so tests don't have to mutate the global. */
export interface LoadBrainConfigOptions {
  brainPath?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Load the Brain Stack config from disk. Returns `null` when Brain is
 * opted-out (file absent AND no FERAL_BRAIN; OR file present with
 * `enabled: false` AND no FERAL_BRAIN).
 *
 * Throws on:
 *   - FERAL_BRAIN=1 but no brain.json (explicit request, missing config)
 *   - brain.json present but malformed (parse error, wrong shape)
 *
 * Does NOT throw on:
 *   - brain.json absent without FERAL_BRAIN (just opt-out, return null)
 */
export function loadBrainConfig(
  opts: LoadBrainConfigOptions = {},
): BrainConfig | null {
  const brainPath = opts.brainPath ?? defaultBrainPath();
  const env = opts.env ?? process.env;
  const forcedEnable = env.FERAL_BRAIN === "1";

  let raw: string;
  try {
    raw = readFileSync(brainPath, "utf8");
  } catch {
    if (forcedEnable) {
      throw new Error(
        `FERAL_BRAIN=1 but brain.json not found at ${brainPath}`,
      );
    }
    // No file, no opt-in → Brain is off.
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `brain.json at ${brainPath} is not valid JSON: ${String(err)}`,
    );
  }

  validateBrainConfigShape(parsed, brainPath);

  // forcedEnable overrides the file's `enabled` flag (headless testing).
  const cfg = parsed as BrainConfig;
  if (forcedEnable) {
    return { ...cfg, enabled: true };
  }
  // Without forcedEnable, the file's own enabled flag decides. enabled:false
  // is the documented way to ship a staged brain.json without turning it on.
  if (!cfg.enabled) {
    return null;
  }
  return cfg;
}

/**
 * Ship alongside the sidecar in `FeralAgent/brain.example.json`. Documents
 * the shape for users who want to write their own by hand before the
 * wizard lands.
 *
 * The loader does NOT auto-seed — the user (or wizard) is responsible
 * for writing the file. "Seed a sensible default" is the wizard's job
 * (post-MVP), not this loader's.
 */
export const BRAIN_EXAMPLE_CONFIG: BrainConfig = {
  enabled: true,
  mode: "balanced",
  // The wizard will populate this from the user's BYOK entries + the
  // local model. The shape below is the bare minimum the loader will
  // accept — it doesn't include every provider family.
  registry: [
    {
      id: "local-default",
      target: {
        provider: "ollama",
        model: "qwen2.5-coder:7b",
        baseUrl: "http://localhost:11434",
      },
      capabilities: { reasoning: 6, coding: 8, vision: 0, speed: 8, multilingual: 5 },
      cost: 1,
      local: true,
    },
  ],
};

function validateBrainConfigShape(raw: unknown, path: string): void {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`brain.json at ${path} must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.enabled !== "boolean") {
    throw new Error(
      `brain.json at ${path}: "enabled" must be a boolean (got ${typeof obj.enabled})`,
    );
  }

  if (typeof obj.mode !== "string" || !VALID_MODES.has(obj.mode as Mode)) {
    throw new Error(
      `brain.json at ${path}: "mode" must be one of ${[...VALID_MODES].join(", ")} (got ${JSON.stringify(obj.mode)})`,
    );
  }

  if (!Array.isArray(obj.registry)) {
    throw new Error(
      `brain.json at ${path}: "registry" must be an array of BrainModel`,
    );
  }

  // We deliberately do NOT validate each BrainModel's inner shape here
  // — BrainStack's constructor enforces it via CapabilityRegistry. Two
  // layers of validation would mean two error messages to reconcile.
}

// Re-export BrainConfig so callers can `import { BrainConfig } from
// "..."brain-config.ts"` and avoid reaching into brain-stack.ts directly.
export type { BrainConfig, Mode } from "./brain-stack.ts";