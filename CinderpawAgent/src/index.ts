/**
 * Cinderpaw Agent — entry point.
 *
 * R7: this file used to hold the entire boot sequence + inbound-message
 * dispatch switch (~2500 lines). Both now live in `boot.ts` (wires the four
 * layers together: Sandbox → Memory → Tools → Agent core → Transport, and
 * arms the message handler) and `dispatch.ts` (the per-message switch). This
 * file is just the process entry point: it re-exports `main()` for
 * `src/tui/chat.ts`'s dynamic `await import("../index.ts")`, re-exports
 * `loadWorkspaceRoots()` for its unit test, and dispatches CLI subcommands.
 */

import type { Transport } from "./types.ts";
import { log, VERSION } from "./runtime-meta.ts";
import { CUSTOM_TOOL_RUNNER_FLAG, runCustomToolModule } from "./tools/custom-tool-runner.ts";

// NOTE: `boot.ts` is deliberately NOT imported statically. It is the hub of
// the whole agent module graph, and several tool modules resolve their
// executable allowlists against PATH at module scope — evaluating it costs
// ~1.5s on Windows (bare compiled Bun floor: ~120ms). A static import here
// made every short-lived invocation pay it: `version`, `help`, an unknown
// subcommand, and every `--custom-tool-runner` child process, i.e. every
// single call of every agent-forged tool. It is now loaded only on the paths
// that actually start the agent. Keep it that way — and keep this file's
// other imports leaf-only.

/**
 * Entry point kept as a thin wrapper (rather than a re-export) so its
 * signature/doc stays the stable public contract `src/tui/chat.ts` relies on
 * regardless of how `boot()`'s own return type evolves.
 *
 * @param transportOverride — when set, use this transport instead of building
 *   the default TauriTransport. Used by the TUI chat loop (src/tui/chat.ts)
 *   which passes a TuiTransport so events fan out in-process instead of
 *   writing JSON to stdout.
 */
export async function main(transportOverride?: Transport): Promise<void> {
  const { boot } = await import("./boot.ts");
  await boot(transportOverride);
}

// ——— CLI dispatch ———
//
// The process is started in one of three ways:
//   1. By the Tauri host (no args) → default → main() with TauriTransport.
//   2. By the user via `cinderpaw chat`  → TUI mode → main() with TuiTransport.
//   3. By the user via `cinderpaw setup` / `cinderpaw-agent setup` → the headless
//      wildcard handler redirects to the canonical `cinderpaw setup` (the Rust
//      CLI, which launches the Go/Bubble Tea wizard). The on-board wizard
//      code has been removed from this binary; nothing here configures Cinderpaw.
//   4. By the user via `cinderpaw help/version` → print and exit.
//
// Dynamic imports break the circular dependency between index.ts and
// src/tui/chat.ts (chat.ts imports main from here).
if (import.meta.main) {
  // Custom-tool runner mode: the forge spawns THIS binary to execute one
  // agent-authored module (tools/custom-tools.ts). Handled before the CLI
  // parser so a tool's module path can never be read as a subcommand.
  //
  const runnerFlagAt = process.argv.indexOf(CUSTOM_TOOL_RUNNER_FLAG);
  if (runnerFlagAt !== -1) {
    await runCustomToolModule(process.argv[runnerFlagAt + 1] ?? "");
    process.exit(0);
  }

  const { parseArgs, tailArgv, dispatch, HELP_TEXT } = await import("./cli.ts");
  const args = parseArgs(tailArgv(process.argv));
  const result = dispatch(args);

  switch (result.kind) {
    case "default":
      // Tauri host (no args) or plain `cinderpaw` from CLI — existing behaviour.
      main().catch((err) => {
        log(`fatal: failed to start — ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      });
      break;

    case "subcommand":
      switch (result.name) {
        case "gateway":
          main().catch((err) => {
            log(`fatal: gateway failed — ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
          });
          break;
        case "chat": {
          const { runChat } = await import("./tui/chat.ts");
          await runChat().catch((err: unknown) => {
            log(`chat error: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
          });
          break;
        }
        case "setup": {
          // Phase 0a (2026-07-07): the on-board wizard lives in the
          // headless `cinderpaw` (Rust) CLI's `--wizard` flow, which launches
          // the Go/Bubble Tea TUI. `cinderpaw-agent setup` (this branch) used
          // to run a hardcoded-Anthropic wizard that silently dropped
          // keys; that surface is gone. Print exactly three lines so
          // that scripted consumers (e.g. CI smoke tests that run the
          // sidecar binary directly) see the canonical command and stop.
          // See `docs/superpowers/specs/2026-07-03-sp0-unify-cinderpaw-cli-design.md`
          // for the canonical command path.
          console.error(
            "cinderpaw-agent setup has moved.\n" +
              "Run \`cinderpaw setup\` instead (the Rust CLI launches the same wizard).\n" +
              "Docs: docs/superpowers/specs/2026-07-03-sp0-unify-cinderpaw-cli-design.md",
          );
          process.exit(2);
          break;
        }
        // `models` and `providers` live in the `cinderpaw` CLI, not here. They
        // used to answer "(not yet implemented — see cinderpaw models in
        // S5.4)", which tells someone who does not work on this codebase two
        // untrue things: that the feature does not exist, and that "S5.4" is
        // somewhere they can go. Same shape as `setup` above — name the real
        // command, exit non-zero so a script does not read the explanation as
        // output.
        case "models":
        case "providers": {
          console.error(
            `cinderpaw-agent is the sidecar; \`${args.subcommand}\` is a CLI command.\n` +
              `Run \`cinderpaw ${args.subcommand}\` instead.`,
          );
          process.exit(2);
          break;
        }
        // `brain` has no CLI command to redirect to — the help text has been
        // promising one that does not exist. The sidecar is what reads
        // brain.json, so it is the honest place to answer from.
        case "brain": {
          const { existsSync } = await import("node:fs");
          const { defaultBrainPath, loadBrainConfig } = await import("./brain/brain-config.ts");
          const path = defaultBrainPath();
          const cfg = loadBrainConfig();
          if (!cfg) {
            // Two different situations, and a person needs to know which:
            // nothing to read, or something read and switched off.
            console.log(
              existsSync(path)
                ? `Brain Stack is OFF.\n${path} exists but does not enable it ` +
                    `(set "enabled": true, or run with CINDERPAW_BRAIN=1).`
                : `Brain Stack is OFF — no brain.json.\n` +
                    `Create ${path} to turn it on; brain.example.json in the ` +
                    `package is a working starting point.`,
            );
            break;
          }
          console.log(`Brain Stack is ON — ${path}`);
          console.log(`  mode: ${cfg.mode}`);
          console.log(`  models: ${cfg.registry.length}`);
          for (const m of cfg.registry) {
            console.log(`    ${m.id}  (${m.target.provider}${m.local ? ", local" : ""})`);
          }
          if (cfg.offlineModelId) console.log(`  offline: ${cfg.offlineModelId}`);
          for (const [category, id] of Object.entries(cfg.overrides ?? {})) {
            console.log(`  pinned ${category}: ${id}`);
          }
          break;
        }
      }
      break;

    case "help":
      console.log(HELP_TEXT);
      break;

    case "version": {
      console.log(`Cinderpaw v${VERSION}`);
      break;
    }

    case "unknown":
      console.error(`Unknown subcommand: ${result.subcommand}`);
      console.log(HELP_TEXT);
      process.exit(1);
      break;
  }
}
