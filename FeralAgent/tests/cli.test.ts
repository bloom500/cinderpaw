/**
 * CLI subcommand routing — slice 5.1 tests.
 *
 * Tests are pure (no I/O): parseArgs, normaliseSubcommand, dispatch,
 * tailArgv are all deterministic functions.
 */

import { describe, expect, test } from "bun:test";
import {
  parseArgs,
  normaliseSubcommand,
  dispatch,
  tailArgv,
  HELP_TEXT,
} from "../src/cli.ts";

// ---------------------------------------------------------------------------
// tailArgv
// ---------------------------------------------------------------------------

describe("tailArgv", () => {
  test("strips first two entries (node + script)", () => {
    expect(tailArgv(["bun", "src/index.ts", "chat", "-v"])).toEqual(["chat", "-v"]);
  });

  test("returns empty when only node + script", () => {
    expect(tailArgv(["bun", "src/index.ts"])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// normaliseSubcommand
// ---------------------------------------------------------------------------

describe("normaliseSubcommand", () => {
  // Gateway
  test('"gateway" → "gateway"', () => expect(normaliseSubcommand("gateway")).toBe("gateway"));
  test('"gw" → "gateway"', () => expect(normaliseSubcommand("gw")).toBe("gateway"));
  test('"GATEWAY" → "gateway"', () => expect(normaliseSubcommand("GATEWAY")).toBe("gateway"));

  // Chat
  test('"chat" → "chat"', () => expect(normaliseSubcommand("chat")).toBe("chat"));
  test('"tui" → "chat"', () => expect(normaliseSubcommand("tui")).toBe("chat"));

  // Setup
  test('"setup" → "setup"', () => expect(normaliseSubcommand("setup")).toBe("setup"));
  test('"init" → "setup"', () => expect(normaliseSubcommand("init")).toBe("setup"));

  // Models
  test('"models" → "models"', () => expect(normaliseSubcommand("models")).toBe("models"));
  test('"model" → "models"', () => expect(normaliseSubcommand("model")).toBe("models"));

  // Providers
  test('"providers" → "providers"', () => expect(normaliseSubcommand("providers")).toBe("providers"));
  test('"provider" → "providers"', () => expect(normaliseSubcommand("provider")).toBe("providers"));

  // Help
  test('"help" → "help"', () => expect(normaliseSubcommand("help")).toBe("help"));
  test('"--help" → "help"', () => expect(normaliseSubcommand("--help")).toBe("help"));
  test('"-h" → "help"', () => expect(normaliseSubcommand("-h")).toBe("help"));

  // Version
  test('"version" → "version"', () => expect(normaliseSubcommand("version")).toBe("version"));
  test('"--version" → "version"', () => expect(normaliseSubcommand("--version")).toBe("version"));
  test('"-v" → "version"', () => expect(normaliseSubcommand("-v")).toBe("version"));
  test('"-V" → "version"', () => expect(normaliseSubcommand("-V")).toBe("version"));

  // Unknown
  test('"foo" → null', () => expect(normaliseSubcommand("foo")).toBeNull());
  test('"" → null', () => expect(normaliseSubcommand("")).toBeNull());
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  test("empty argv → subcommand null, positional empty", () => {
    expect(parseArgs([])).toEqual({ subcommand: null, positional: [] });
  });

  test("known subcommand first → parsed, rest in positional", () => {
    expect(parseArgs(["chat", "--foo", "bar"])).toEqual({
      subcommand: "chat",
      positional: ["--foo", "bar"],
    });
  });

  test("unknown first → subcommand null, positional = argv", () => {
    expect(parseArgs(["nope", "chat"])).toEqual({
      subcommand: null,
      positional: ["nope", "chat"],
    });
  });

  test("alias 'gw' still lands positional after", () => {
    const r = parseArgs(["gw", "extra"]);
    expect(r.subcommand).toBe("gateway");
    expect(r.positional).toEqual(["extra"]);
  });

  test("alias 'tui' maps to chat", () => {
    expect(parseArgs(["tui"]).subcommand).toBe("chat");
  });

  test("alias 'init' maps to setup", () => {
    expect(parseArgs(["init"]).subcommand).toBe("setup");
  });
});

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

describe("dispatch", () => {
  test("null subcommand → kind 'default'", () => {
    expect(dispatch({ subcommand: null, positional: [] })).toEqual({ kind: "default" });
  });

  test("help → kind 'help'", () => {
    expect(dispatch({ subcommand: "help", positional: [] })).toEqual({ kind: "help" });
  });

  test("version → kind 'version'", () => {
    expect(dispatch({ subcommand: "version", positional: [] })).toEqual({ kind: "version" });
  });

  function subDispatch(name: string): void {
    test(`${name} → subcommand ${name}`, () => {
      const r = dispatch({ subcommand: name as never, positional: [] });
      expect(r).toEqual({ kind: "subcommand", name });
    });
  }

  subDispatch("gateway");
  subDispatch("chat");
  subDispatch("setup");
  subDispatch("models");
  subDispatch("providers");
  subDispatch("brain");
});

// ---------------------------------------------------------------------------
// HELP_TEXT — quick smoke
// ---------------------------------------------------------------------------

describe("HELP_TEXT", () => {
  test("contains subcommands", () => {
    expect(HELP_TEXT).toMatch(/feral/);
    expect(HELP_TEXT).toMatch(/chat/);
    expect(HELP_TEXT).toMatch(/setup/);
    expect(HELP_TEXT).toMatch(/help/);
    expect(HELP_TEXT).toMatch(/version/);
  });

  test("is plain text (no ANSI)", () => {
    expect(HELP_TEXT).not.toMatch(/\x1b\[/);
  });
});