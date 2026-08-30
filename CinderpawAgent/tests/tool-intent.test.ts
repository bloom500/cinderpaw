/**
 * Tool intent routing.
 *
 * The property that matters is not accuracy, it is the SHAPE of the mistakes:
 * being wrong must cost one drawer round trip, never a capability. So most of
 * these test the fail-open path rather than the happy one.
 */

import { describe, expect, test } from "bun:test";
import {
  ALWAYS_TOOLS,
  INTENT_PATTERNS,
  INTENT_TOOLS,
  MIN_SIGNAL_CHARS,
  classifyToolIntents,
  selectTools,
  type ToolIntent,
} from "../src/tools/tool-intent.ts";
import { CONNECTOR_TOOLS, EXTENDED_TOOLS, isCoreTool } from "../src/tools/tiers.ts";

/** A stand-in for the owner's advertised set, big enough for the 33% floor. */
const CORE = [
  "read_file", "write_file", "edit_file", "list_directory", "file_search", "grep",
  "scan_workspace", "git_status", "git_diff", "git_log", "git_commit", "git_branch",
  "shell_exec", "web_search", "read_webpage", "recall", "remember", "self_describe",
  "self_status", "self_health", "self_tools", "self_subsystem", "product_info",
  "delegate_task", "cowork_team", "cowork_send", "list_tools", "load_tool", "ask_user",
  "todo_write", "cinderpaw_admin", "notebook",
];

describe("classifyToolIntents", () => {
  test("files work is recognised", () => {
    expect(classifyToolIntents("read the config file and tell me what is in it")).toContain("files");
  });

  test("intents are ADDITIVE — a turn can need two toolkits", () => {
    // The model classifier next door picks one category because a turn has one
    // best model. A turn can need several toolkits.
    const i = classifyToolIntents("read src/config.ts and commit the change to git");
    expect(i).toContain("files");
    expect(i).toContain("code");
  });

  test("a file extension is enough on its own", () => {
    expect(classifyToolIntents("what does main.rs actually do here")).toContain("files");
  });

  test("a URL means web", () => {
    expect(classifyToolIntents("summarise https://example.com/page for me")).toContain("web");
  });

  test("pure conversation asks for nothing", () => {
    expect(classifyToolIntents("what is a deadlock in operating systems").size).toBe(0);
  });

  test("short input is not evidence — it fails open", () => {
    // "do it" continues a task; treating it as "no tools needed" would strip
    // the toolset on exactly the turn that needs it.
    expect(classifyToolIntents("do it").size).toBe(0);
    expect("do it".length).toBeLessThan(MIN_SIGNAL_CHARS);
  });

  test("non-strings do not throw", () => {
    expect(classifyToolIntents(undefined as unknown as string).size).toBe(0);
    expect(classifyToolIntents("").size).toBe(0);
  });
});

describe("word boundaries — the false positives the sibling classifier warns about", () => {
  // Each string CONTAINS the pattern as a raw substring, so a boundary-less
  // regex would match it. The first draft of this block used words that no
  // pattern contained at all — they passed without testing anything, which is
  // the failure mode a "we have tests" claim is built on.
  const cases: [string, ToolIntent, string][] = [
    ["I have already done that", "files", "read"],
    ["my credit card details", "files", "edit"],
    ["brunch at noon on Sunday", "system", "run"],
    ["the contests are over now", "code", "tests"],
    ["he is forgetful lately", "memory", "forget"],
  ];
  for (const [text, intent, substring] of cases) {
    test(`"${text}" contains "${substring}" but does not trigger ${intent}`, () => {
      // Self-proving: strip the boundaries out of that intent's patterns and
      // assert the crippled version DOES match. Without this the case can pass
      // because no pattern contains the substring at all — which is how two of
      // these were written the first time, and how a test block can look
      // thorough while asserting nothing.
      const withoutBoundaries = INTENT_PATTERNS[intent].map(
        // NOTE the escaping. The argument must be the TWO characters
        // backslash and b. Written with a single backslash, JS reads it as the
        // backspace control character, the replacement matches nothing, and
        // every case here passes while proving nothing. That happened on the
        // first attempt at this block, which is why the assertion above exists
        // at all: a test that cannot fail is worse than no test.
        (p) => new RegExp(p.source.split("\\b").join(""), "i"),
      );
      expect(withoutBoundaries.some((p) => p.test(text))).toBe(true);
      // And the real, bounded patterns do not.
      expect(classifyToolIntents(text).has(intent)).toBe(false);
    });
  }

  test("every pattern uses a boundary or an anchor, none is a bare substring", () => {
    for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
      for (const p of patterns) {
        const src = p.source;
        const anchored = src.includes("\\b") || src.includes("```") || src.startsWith("https?");
        expect(`${intent}: ${src} anchored=${anchored}`).toBe(`${intent}: ${src} anchored=true`);
      }
    }
  });
});

describe("selectTools — fail open is the contract", () => {
  test("no signal returns the core set UNCHANGED", () => {
    const out = selectTools({ text: "what is a deadlock in operating systems", coreTools: CORE });
    expect(out).toEqual(CORE);
  });

  test("empty text returns the core set unchanged", () => {
    expect(selectTools({ text: "", coreTools: CORE })).toEqual(CORE);
  });

  test("a narrow ask really does narrow", () => {
    const out = selectTools({ text: "read src/config.ts and show me the exports", coreTools: CORE });
    expect(out.length).toBeLessThan(CORE.length);
    expect(out).toContain("read_file");
  });

  test("the escape hatch is never withheld", () => {
    // Without list_tools/load_tool a wrong guess is unrecoverable, which turns
    // a cost optimisation into a capability bug.
    const out = selectTools({ text: "read src/config.ts and show me the exports", coreTools: CORE });
    for (const name of ALWAYS_TOOLS) expect(out).toContain(name);
  });

  test("it can only ever return a SUBSET of what it was given", () => {
    const out = selectTools({ text: "read src/config.ts and commit it", coreTools: CORE });
    for (const name of out) expect(CORE).toContain(name);
  });

  test("a tool the caller does not advertise is never conjured in", () => {
    // read_file is in the files intent, but not in this caller's set.
    const tiny = ["list_tools", "load_tool", "ask_user", "todo_write", "web_search"];
    const out = selectTools({ text: "read src/config.ts please", coreTools: tiny });
    expect(out).not.toContain("read_file");
  });

  test("a saving too small to be worth a miss is not taken", () => {
    // Removing two tools out of thirty does not repay the round trip a wrong
    // guess costs, so the whole set is kept.
    const out = selectTools({
      text: "read a file, run a command, search the web, recall a memory, check your health, delegate it",
      coreTools: CORE,
    });
    expect(out).toEqual(CORE);
  });

  test("a missing coreTools argument does not throw", () => {
    expect(() => selectTools({ text: "read a file", coreTools: undefined as never })).not.toThrow();
  });
});

describe("the map cannot rot", () => {
  test("every mapped tool name is a real tool name", () => {
    // The explicit list is only safe to hand-write because this guard exists:
    // a rename would otherwise drop a tool from its intent in silence, which is
    // the same failure shape as the hardcoded paths fixed earlier today.
    const real = new Set([...CORE, ...EXTENDED_TOOLS, ...CONNECTOR_TOOLS]);
    const mapped = new Set<string>([...ALWAYS_TOOLS, ...Object.values(INTENT_TOOLS).flat()]);
    const unknown = [...mapped].filter((n) => !real.has(n));
    expect(unknown).toEqual([]);
  });

  test("every ALWAYS tool is core — a drawered escape hatch is not an escape hatch", () => {
    for (const name of ALWAYS_TOOLS) expect(isCoreTool(name)).toBe(true);
  });

  test("every intent has both patterns and tools", () => {
    for (const intent of Object.keys(INTENT_TOOLS) as ToolIntent[]) {
      expect(INTENT_TOOLS[intent].length).toBeGreaterThan(0);
      expect(INTENT_PATTERNS[intent].length).toBeGreaterThan(0);
    }
  });
});

describe("tools the classifier has never heard of", () => {
  // The real shape this missed: with CINDERPAW_HOST_TOOLS set, the core set is
  // the host's tools and NONE of them appear in any intent map. The old filter
  // read that as "none of these are needed" and stripped the whole job.
  const HOST = ["book_reservation", "search_direct_flight", "cancel_reservation", "get_user_details"];

  test("a host's tools survive a message that looks like a different intent", () => {
    const core = [...HOST, "list_tools", "load_tool"];
    const out = selectTools({ text: "I'd like to book a one-way flight and read my details", coreTools: core });
    for (const name of HOST) expect(out).toContain(name);
  });

  test("an unknown tool is kept even when a known one next to it is dropped", () => {
    const core = ["read_file", "write_file", "git_commit", "some_mcp_tool", ...HOST];
    const out = selectTools({ text: "search the web for the changelog and summarise it", coreTools: core });
    expect(out).toContain("some_mcp_tool");
    for (const name of HOST) expect(out).toContain(name);
  });
});
