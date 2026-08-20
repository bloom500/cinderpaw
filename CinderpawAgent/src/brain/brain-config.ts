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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { BrainConfig } from "./brain-stack.ts";
import type { Mode } from "./brain-stack.ts";
import type { ModelTarget } from "../types.ts";
import type { BrainModel } from "./capability-registry.ts";
import { profileFor } from "./model-profiles.ts";
import { feralHome } from "../config.ts";

const VALID_MODES: ReadonlySet<Mode> = new Set<Mode>([
  "budget",
  "balanced",
  "quality",
]);

/**
 * Mode used when Brain is derived rather than configured. `balanced` —
 * capability weighted by cost — is the only defensible default: `budget`
 * silently prefers the weaker local model for work it will fail, and
 * `quality` spends the user's money without being asked.
 */
const DEFAULT_MODE: Mode = "balanced";

/**
 * Default location for brain.json: `$FERAL_HOME/brain.json` if set,
 * else `~/.feral/brain.json`. Exported so callers (and tests) can
 * discover the same path the loader would use.
 */
export function defaultBrainPath(): string {
  return join(feralHome(), "brain.json");
}

/**
 * Does a brain.json exist at all?
 *
 * `loadBrainConfig()` returns `null` for two different situations — "no
 * file" and "file says enabled: false" — and the caller must not treat
 * them the same. Deriving a default config over a user who deliberately
 * turned Brain off would override an explicit decision; deriving one when
 * there is simply no file is the whole point of Phase 1.
 */
export function brainConfigFileExists(
  opts: LoadBrainConfigOptions = {},
): boolean {
  return existsSync(opts.brainPath ?? defaultBrainPath());
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
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (forcedEnable) {
      throw new Error(
        code === "ENOENT" || code === undefined
          ? `FERAL_BRAIN=1 but brain.json not found at ${brainPath}`
          : `FERAL_BRAIN=1 but brain.json could not be read at ${brainPath} (${code})`,
      );
    }
    // ONLY "the file is not there" means opted out. Any other failure — no
    // permission to read it, a broken symlink, an I/O error — used to look
    // identical, so a brain.json the user had written and could see on disk was
    // silently ignored and the whole routing config appeared never to have
    // existed. That is the failure they cannot debug: nothing is wrong on
    // screen, and the model choice is simply not theirs.
    if (code !== undefined && code !== "ENOENT") {
      throw new Error(
        `brain.json exists at ${brainPath} but could not be read (${code}): ${String(err)}`,
      );
    }
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
 * Build a Brain config from the model targets the inference router is
 * already configured with, so Brain works on a machine that has never
 * seen a `brain.json`.
 *
 * Why this exists: before Phase 1, `loadBrainConfig()` returning `null`
 * was the ONLY outcome on a normal installation — nothing in the product
 * ever wrote the file, so every shipped copy of Cinderpaw ran with model
 * routing absent, not degraded (docs/ui/2026-08-19-brain-current-state.md
 * §3, §10). `brain.example.json` even claimed `feral setup` would write
 * it; nothing did.
 *
 * Scope: the sidecar knows at most two targets — the router's `#primary`
 * and `#fallback` (egress/inference-router.ts:157). There is no inventory
 * of every installed local model inside this process. Handing Brain the
 * full list needs host→sidecar plumbing and is a later slice; this
 * function is the single seam that slice replaces.
 *
 * Two targets is not a token gesture: local + cloud is exactly the case
 * where routing earns its keep (local for `simple`/`speed`, cloud for
 * `reasoning`/`vision`). One target degenerates to "pick the only model",
 * which is correct, honest, and still better than no Brain at all.
 *
 * Returns `null` when there is nothing to route to — with zero usable
 * targets the caller has no model at all, which is a different problem
 * with a different answer (the UI's zero-model reply), not a routing one.
 */
export function deriveDefaultConfig(
  targets: ReadonlyArray<ModelTarget | undefined>,
): BrainConfig | null {
  const registry: BrainModel[] = [];
  const seen = new Set<string>();

  for (const target of targets) {
    if (!target) continue;
    // The registry must not contain duplicate ids — CapabilityRegistry
    // throws on them, and primary/fallback are frequently the same model
    // pointed at two endpoints.
    const id = `${target.provider}:${target.model}`;
    if (seen.has(id)) continue;
    seen.add(id);
    registry.push({ id, target, ...profileFor(target) });
  }

  if (registry.length === 0) return null;

  return { enabled: true, mode: DEFAULT_MODE, registry };
}

/**
 * Rebuild a DERIVED brain config when the host switches models.
 *
 * `set_model` rebuilds the router's trusted-URL set from the new targets and
 * drops the old ones. The Brain Stack used to be built once at boot and never
 * again, so after a switch it kept routing to the previous provider — which
 * the trust check then refused, ending every turn with "refusing to contact
 * untrusted inference endpoint" naming an endpoint the user had just left.
 *
 * The refusal was the symptom. Routing to a provider the user switched away
 * from is the fault: it sends the conversation, and the key, somewhere they
 * stopped choosing.
 *
 * Returns `null` when the brain was NOT derived — a hand-written brain.json is
 * a deliberate choice of models, and a model switch is not permission to
 * overwrite it. The caller keeps the brain it has.
 */
export function rebuildDerivedBrain(
  wasDerived: boolean,
  primary: ModelTarget,
  fallback: ModelTarget | undefined,
): BrainConfig | null {
  if (!wasDerived) return null;
  return deriveDefaultConfig([primary, fallback]);
}

/**
 * Ship alongside the sidecar in `CinderpawAgent/brain.example.json`. Documents
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
      // Cinderpaw's OWN model server, not an external Ollama on 11434. Pointing
      // the example at 11434 sent anyone who copied it to a different program
      // that may not be installed, running, or holding the model they picked in
      // Cinderpaw — and the UI's own model selector targets 11435 for exactly that
      // reason. `model` is whatever is loaded here, so it is left as a
      // placeholder rather than a name that may not exist on this machine.
      target: {
        provider: "openai_compatible",
        model: "REPLACE-ME-with-the-model-you-loaded-in-Cinderpaw",
        baseUrl: "http://localhost:11435",
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