/**
 * CLI subcommand routing — Feral headless slice 5.1.
 *
 * Maps `feral <subcommand> [args...]` to a handler. The handlers themselves
 * live in `src/tui/` (chat, setup) and in `src/index.ts` (the gateway).
 * This file is JUST routing — pure parse + dispatch table.
 *
 * Subcommand map (Faza 4.5 MVP):
 *
 *   feral (no subcommand)         → default = gateway (background daemon)
 *   feral gateway                  → gateway foreground (Ctrl+C to stop)
 *   feral chat                     → interactive TUI in the terminal
 *   feral setup                    → one-time wizard: writes ~/.feral/
 *   feral models                   → list installed local models (stub for S5.4)
 *   feral providers                → list configured providers (stub for S5.4)
 *   feral brain                    → show brain.json + active routes (stub)
 *   feral help                     → print this map
 *
 * Unknown subcommands → error + help (no silent fallback). The user can
 * always re-run with `feral help` to see what they meant.
 *
 * Args parsing is intentionally minimal: positional only, no flags. Flags
 * come later when a subcommand actually needs one (e.g. `feral gateway
 * --port 11436`). Adding a flag parser now would be premature — and a
 * hand-rolled flag parser is the wrong call once we need one (use
 * commander / yargs). Keep this thin until there's a real need.
 */

export type Subcommand =
  | "gateway"
  | "chat"
  | "setup"
  | "models"
  | "providers"
  | "brain"
  | "help"
  | "version";

/** Args parsed from the user's command line. */
export interface ParsedArgs {
  /** Subcommand, or null when the user ran `feral` with no arg. */
  subcommand: Subcommand | null;
  /** Positional arguments AFTER the subcommand. */
  positional: string[];
}

/** Result of running the CLI dispatcher. */
export type DispatchResult =
  | { kind: "default" } // no subcommand → run gateway
  | { kind: "subcommand"; name: Exclude<Subcommand, "help" | "version"> }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "unknown"; subcommand: string };

/** Parse argv (already stripped of node + script entry) into a structured result. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [first, ...rest] = argv;
  if (first === undefined) {
    return { subcommand: null, positional: [] };
  }
  // Normalise: `feral help` / `feral --help` / `feral -h` all → "help".
  const normalised = normaliseSubcommand(first);
  if (normalised === null) {
    // Unknown token at position 1: not a subcommand.
    return { subcommand: null, positional: [...argv] };
  }
  return { subcommand: normalised, positional: rest };
}

/** Map raw user input to a known subcommand. Returns null if unknown. */
export function normaliseSubcommand(raw: string): Subcommand | null {
  const lower = raw.toLowerCase();
  switch (lower) {
    case "gateway":
    case "gw":
      return "gateway";
    case "chat":
    case "tui":
      return "chat";
    case "setup":
    case "init":
      return "setup";
    case "models":
    case "model":
      return "models";
    case "providers":
    case "provider":
      return "providers";
    case "brain":
      return "brain";
    case "help":
    case "--help":
    case "-h":
      return "help";
    case "version":
    case "--version":
    case "-v":
    case "-V":
      return "version";
    default:
      return null;
  }
}

/** Decide what to do based on the parsed args. Pure — caller executes. */
export function dispatch(args: ParsedArgs): DispatchResult {
  if (args.subcommand === null) {
    return { kind: "default" };
  }
  switch (args.subcommand) {
    case "help":
      return { kind: "help" };
    case "version":
      return { kind: "version" };
    case "gateway":
    case "chat":
    case "setup":
    case "models":
    case "providers":
    case "brain":
      return { kind: "subcommand", name: args.subcommand };
  }
}

/**
 * The help text — shown on `feral help` or when an unknown subcommand
 * is supplied. Plain text (no ANSI) so it pipes cleanly into `less`,
 * `grep`, etc.
 */
export const HELP_TEXT = `Feral — headless AI agent

Usage:
  feral                  Run the gateway daemon in the foreground.
  feral gateway          Same, foreground. Ctrl+C to stop.
  feral chat             Interactive terminal chat over the gateway.
  feral setup            One-time wizard: write ~/.feral/, seed brain.json.
  feral models           List installed local models.
  feral providers        List configured cloud providers.
  feral brain            Show brain.json + the active routing policy.
  feral help             This text.
  feral version          Print version and exit.

Environment:
  FERAL_HOME             Feral state directory (default: ~/.feral).
  FERAL_BRAIN=1          Force-enable Brain Stack using brain.json.
  NO_COLOR               Disable ANSI colors in TUI output.

First-time setup:
  feral setup            writes ~/.feral/brain.json with sane defaults
  feral chat             talk to Feral from the terminal
`;

/** Pull out argv past the node + script entry — kept for tests. */
export function tailArgv(argv: readonly string[]): string[] {
  return argv.slice(2);
}