/**
 * The gate that keeps the agent's self-description from drifting away from what
 * it actually is.
 *
 * There was already a rule saying "update PRODUCT.md when you add a feature".
 * It was written down, it was in the project notes, and it still went stale: an
 * entire reliability workstream — the notebook, the task list, unattended runs,
 * the walk-away digest, compaction, the scratchpad — landed over two weeks and
 * not one of them reached the document the agent answers from. Asked "how do you
 * keep your place on a long task", it would have said it could not, or invented
 * something.
 *
 * A rule a human has to remember is a rule that holds by accident. This one
 * fails the build instead.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const PRODUCT = readFileSync(join(SRC, "PRODUCT.md"), "utf8");

/**
 * Tools deliberately absent from PRODUCT.md, each with the reason.
 *
 * Adding a name here is a decision, not a shortcut — which is the point. The
 * large group is the `self_*` family: those are enumerated by `self_tools`
 * STRAIGHT FROM THE LIVE REGISTRY, so hand-copying them into a static document
 * would recreate exactly the drift this test exists to prevent. PRODUCT.md
 * instead teaches the agent to call them, which cannot go stale.
 */
const NOT_IN_PRODUCT_DOC: Record<string, string> = {
  // Enumerated from the registry at runtime — documenting by hand would drift.
  self_describe: "listed by self_tools", self_status: "listed by self_tools",
  self_runtime: "listed by self_tools", self_tools: "listed by self_tools",
  self_providers: "listed by self_tools", self_memory: "listed by self_tools",
  self_connectors: "listed by self_tools", self_genome: "listed by self_tools",
  self_dreams: "listed by self_tools", self_lora: "listed by self_tools",
  self_health: "listed by self_tools", self_subsystem: "listed by self_tools",
  self_progress: "listed by self_tools",
  list_tools: "the tool browser itself; self_tools is the documented entry point",
  load_tool: "drawer mechanics — the model uses it, the user never asks about it",
  tool_health: "internal reliability telemetry, surfaced via self_health",
  tool_forge: "RSI-internal; the RSI section covers the capability",
  // Ordinary primitives. A user asking "can you read a file" is answered by the
  // capability sections, not by a manifest listing.
  read_file: "generic file primitive", list_directory: "generic file primitive",
  file_search: "generic file primitive", grep: "generic file primitive",
  calculator: "generic primitive", time_date: "generic primitive",
  fetch_url: "generic primitive", http_request: "generic primitive",
  read_webpage: "generic primitive", web_search: "generic primitive",
  deep_research: "generic primitive", scan_workspace: "generic primitive",
  shell_exec: "generic primitive", control_app: "generic primitive",
  read_skill: "skills mechanics", list_skills: "skills mechanics",
  git_status: "git primitive", git_diff: "git primitive", git_log: "git primitive",
  git_commit: "git primitive", git_branch: "git primitive",
  ask_user: "turn mechanics", escalate_to_human: "turn mechanics",
  delegate_task: "subagent mechanics",
  capture_lead: "public-persona connector feature, covered by the WhatsApp section",
  schedule_meeting: "public-persona connector feature",
  recall: "the read half of memory; the memory section covers the capability",
};

/** Every builtin tool's registered name, read from the source of truth. */
function registeredToolNames(): string[] {
  const dir = join(SRC, "tools", "builtin");
  const names = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const body = readFileSync(join(dir, file), "utf8");
    for (const m of body.matchAll(/^\s+name:\s*"([a-z_0-9]+)"/gm)) names.add(m[1]!);
  }
  return [...names].sort();
}

test("every tool is either documented for the user or explicitly excluded", () => {
  const undocumented = registeredToolNames().filter(
    (name) => !PRODUCT.includes(name) && !(name in NOT_IN_PRODUCT_DOC),
  );
  expect(undocumented).toEqual([]);
});

test("the exclusion list has no dead entries", () => {
  // A tool that was renamed or deleted must not leave a stale excuse behind,
  // or the list slowly becomes a place where anything can hide.
  const registered = new Set(registeredToolNames());
  const stale = Object.keys(NOT_IN_PRODUCT_DOC).filter((n) => !registered.has(n));
  expect(stale).toEqual([]);
});

test("the capabilities that made this gate necessary are in the document", () => {
  // The exact set that had gone missing. Named individually so a future rewrite
  // of PRODUCT.md cannot quietly drop one of them again.
  for (const capability of [
    "notebook",
    "note:position",
    "todo_write",
    "scratchpad",
    "digest",
    "continuation",
    "deadline",
    "replan",
    "Compaction",
  ]) {
    expect(PRODUCT).toContain(capability);
  }
});

test("the document does not contradict what the agent can actually do", () => {
  // It used to state flatly that the agent cannot write under ~/.cinderpaw. The
  // scratchpad lives there and is writable by design, so that sentence became a
  // lie the agent would repeat with confidence. A wrong self-description is
  // worse than a missing one.
  const home = PRODUCT.slice(PRODUCT.indexOf("## What Cinderpaw is NOT"));
  expect(home).toContain("workspace");
  expect(home).toMatch(/exception/i);
});
