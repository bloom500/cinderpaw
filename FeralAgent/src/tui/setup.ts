/**
 * One-time setup wizard — Feral headless slice 5.1.
 *
 * Creates `~/.feral/` directory and writes a minimal `brain.json` with
 * sensible defaults. Interactive: prompts the user to confirm each path.
 *
 * Designed to be run standalone from `feral setup` without the full agent
 * stack. Pure I/O — no dependencies beyond `node:fs`, `node:path`,
 * `node:readline`.
 */

import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import * as readline from "node:readline";
import {
  shouldUseColor,
  brand,
  primary,
  muted,
  dim,
  success,
} from "./render.ts";

/**
 * Resolve the Feral home dir. MUST agree with brain-config's
 * `defaultBrainPath()` or the wizard writes brain.json where the runtime
 * never looks. Order: test override → `FERAL_HOME` env → `~/.feral`.
 * `FERAL_HOME`, when set, is the feral dir itself (not a parent).
 */
function feralHome(overrides?: { homeDir?: string }): string {
  if (overrides?.homeDir) return resolve(overrides.homeDir, ".feral");
  return process.env.FERAL_HOME ?? resolve(homedir(), ".feral");
}

export interface SetupResult {
  /** True when the wizard actually wrote files (not just detected existing). */
  created: boolean;
  /** Path to the brain.json that was written (or already existed). */
  brainPath: string;
}

/**
 * Run the setup wizard. This is an interactive terminal session — it reads
 * from stdin and writes to stdout/stderr. Non-interactive callers (tests)
 * can pass a canned answers array.
 */
/**
 * @param cannedAnswers  For non-interactive callers (tests) — array of answers to
 *   prompt questions in order.
 * @param opts.homeDir   Override the home directory (default: os.homedir()).
 *   Used by tests to keep files in a temp dir without touching ~/.feral/.
 */
export async function runSetup(cannedAnswers?: string[], opts?: { homeDir?: string }): Promise<SetupResult> {
  const useColor = shouldUseColor();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const ask = async (prompt: string, defaultAnswer: string): Promise<string> => {
    if (cannedAnswers && cannedAnswers.length > 0) {
      const answer = cannedAnswers.shift()!;
      console.log(`${prompt} ${answer}`);
      return answer;
    }
    return new Promise((resolve) => {
      rl.question(prompt, (answer) => {
        resolve(answer.trim() || defaultAnswer);
      });
    });
  };

  try {
    console.log();
    console.log(`  ${brand("Feral", useColor)} ${muted("headless AI agent — setup", useColor)}`);
    console.log(`  ${muted("────────────────────────────", useColor)}`);
    console.log();

    // ——— Detect existing feralHome(opts) ———
    const alreadySetup = existsSync(feralHome(opts)) && existsSync(resolve(feralHome(opts), "brain.json"));
    if (alreadySetup) {
      console.log(`  ${primary("✓", useColor)} Already set up at ${muted(feralHome(opts), useColor)}`);
      console.log();
      const answer = await ask(`  ${dim("Re-run anyway? [y/N] ", useColor)}`, "n");
      if (answer.toLowerCase() !== "y") {
        console.log(`  ${dim("Nothing changed.", useColor)}`);
        console.log();
        return { created: false, brainPath: resolve(feralHome(opts), "brain.json") };
      }
    }

    // ——— Ensure ~/.feral/ exists ———
    mkdirSync(feralHome(opts), { recursive: true });
    console.log(`  ${success("✓", useColor)} Created ${muted(feralHome(opts), useColor)}`);

    // ——— Ask about local model ———
    console.log();
    console.log(`  ${primary("Local model", useColor)}`);
    console.log(`  ${muted("  Feral runs best with a local LLM (Ollama / llama.cpp).", useColor)}`);
    const localModel = await ask(`  ${dim("Local model name [qwen2.5:7b]: ", useColor)}`, "qwen2.5:7b");
    const localUrl = await ask(`  ${dim("Local model URL [http://127.0.0.1:11435]: ", useColor)}`, "http://127.0.0.1:11435");

    // ——— Ask about cloud fallback ———
    console.log();
    console.log(`  ${primary("Cloud fallback (optional)", useColor)}`);
    console.log(`  ${muted("  When the local model can't handle a task, Feral can fall back to a", useColor)}`);
    console.log(`  ${muted("  cloud provider. Leave blank to skip.", useColor)}`);
    const useCloud = await ask(`  ${dim("Cloud model name (e.g. claude-sonnet-4-20250514) [none]: ", useColor)}`, "");

    let cloudUrl = "";
    let apiKey = "";
    if (useCloud) {
      cloudUrl = await ask(`  ${dim("Cloud API URL [https://api.anthropic.com/v1]: ", useColor)}`, "https://api.anthropic.com/v1");
      apiKey = await ask(`  ${dim("API key: ", useColor)}`, "");
    }

    // ——— Write brain.json ———
    // MUST match the shape loadBrainConfig() consumes: {enabled, mode,
    // registry: BrainModel[]}. The wizard is the official config source —
    // anything it writes has to load, or `FERAL_BRAIN=1` / brain-enabled
    // chat throws on first run.
    //
    // Capability vectors below are sane defaults (0..10). They're a tuning
    // knob, not a measurement — the scorer only uses them relatively, and
    // a user can hand-edit brain.json later. ponytail: default vectors;
    // per-model calibration when we actually benchmark models.
    const registry: Record<string, unknown>[] = [
      {
        id: "local",
        target: {
          provider: "openai_compatible",
          model: localModel || "qwen2.5:7b",
          baseUrl: localUrl || "http://127.0.0.1:11435",
        },
        capabilities: { reasoning: 5, coding: 6, vision: 0, speed: 8, multilingual: 5 },
        cost: 1,
        local: true,
      },
    ];

    if (useCloud) {
      registry.push({
        id: "cloud",
        target: {
          provider: "anthropic",
          model: useCloud,
          baseUrl: cloudUrl || "https://api.anthropic.com/v1",
          ...(apiKey ? { apiKey } : {}),
        },
        capabilities: { reasoning: 9, coding: 9, vision: 7, speed: 6, multilingual: 8 },
        cost: 3,
        local: false,
      });
    }

    const brainConfig: Record<string, unknown> = {
      enabled: true,
      mode: "balanced",
      // Force the local model whenever no cloud is reachable — the whole
      // point of the offline category.
      offlineModelId: "local",
      registry,
    };

    const brainPath = resolve(feralHome(opts), "brain.json");
    writeFileSync(brainPath, JSON.stringify(brainConfig, null, 2) + "\n");
    console.log();
    console.log(`  ${success("✓", useColor)} Wrote ${muted(brainPath, useColor)}`);

    // ——— Summary ———
    console.log();
    console.log(`  ${primary("Setup complete.", useColor)}`);
    console.log(`  ${dim("  Run  ", useColor)}${brand("feral chat", useColor)}${dim("  to start a conversation.", useColor)}`);
    console.log();

    return { created: true, brainPath };
  } finally {
    rl.close();
  }
}