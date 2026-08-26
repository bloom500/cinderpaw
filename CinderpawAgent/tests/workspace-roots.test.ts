/**
 * loadWorkspaceRoots — sandbox root resolution.
 *
 * Contract (post sandbox-relax): roots are broad by default — unset
 * FERAL_WORKSPACE means launch cwd + the user's home dir. The self-protection
 * guarantee moved to CALL TIME (resolveAllowedPath's deny wall over ~/.feral,
 * ~/.ssh, FERAL_FS_DENY — tested in sandbox.test.ts). Here we only assert
 * that roots sitting INSIDE ~/.feral are still dropped at registration.
 */
import { test, expect } from "bun:test";
import { resolve, delimiter, parse } from "node:path";
import { homedir } from "node:os";
// Imported from boot.ts, where it is defined. index.ts used to re-export it,
// but that static re-export forced every short-lived invocation to evaluate
// the whole agent module graph — see the note in index.ts.
import { loadWorkspaceRoots } from "../src/boot.ts";
import { agentProfileDirs, feralHome } from "../src/config.ts";

// The profile dir the code actually uses, not a second hardcoded copy of
// it: this test asserted ".feral" while the app had moved to ".cinderpaw",
// which is the same drift the deny wall was suffering from.
const FERAL_HOME = feralHome();
const SCRATCH = resolve(FERAL_HOME, "workspace");

test("explicit FERAL_WORKSPACE list is honored and scratch is always added", () => {
  const a = resolve("/tmp/proj-a");
  const b = resolve("/tmp/proj-b");
  const roots = loadWorkspaceRoots({ FERAL_WORKSPACE: [a, b].join(delimiter) } as NodeJS.ProcessEnv);
  expect(roots).toContain(a);
  expect(roots).toContain(b);
  expect(roots).toContain(SCRATCH); // dedicated owned workspace always present
});

test("unset FERAL_WORKSPACE defaults to cwd + home (broad by default)", () => {
  const roots = loadWorkspaceRoots({} as NodeJS.ProcessEnv);
  expect(roots).toContain(resolve(process.cwd()));
  expect(roots).toContain(resolve(homedir()));
  expect(roots).toContain(SCRATCH);
});

test("ancestors of ~/.feral (home, drive root) are allowed as roots", () => {
  // The deny wall in resolveAllowedPath guards the brain per-access now;
  // broad roots are the point of the lax sandbox.
  const fsRoot = parse(FERAL_HOME).root;
  const roots = loadWorkspaceRoots({
    FERAL_WORKSPACE: [homedir(), fsRoot].join(delimiter),
  } as NodeJS.ProcessEnv);
  expect(roots).toContain(resolve(homedir()));
  expect(roots).toContain(resolve(fsRoot));
});

test("a root INSIDE ~/.feral is still dropped (brain exposure at registration)", () => {
  const rsiRepo = resolve(FERAL_HOME, "rsi");
  const agentDir = resolve(FERAL_HOME, "agent");
  const realProject = resolve("/tmp/legit-project");
  const roots = loadWorkspaceRoots({
    FERAL_WORKSPACE: [rsiRepo, agentDir, realProject].join(delimiter),
  } as NodeJS.ProcessEnv);
  expect(roots).not.toContain(rsiRepo);
  expect(roots).not.toContain(agentDir);
  expect(roots).toContain(realProject); // a legit sibling root still survives
  expect(roots).toContain(SCRATCH); // the one allowed ~/.feral subtree
});

test("a root inside EITHER profile dir is dropped, not just the current one", () => {
  // The rename migration copies ~/.feral to ~/.cinderpaw and never deletes the
  // source, so both hold agent state on a migrated machine. When this guard
  // tracked only the live one, the day the host migrated silently flipped
  // which directory was protected and which was handed to the fs tools.
  const dirs = agentProfileDirs();
  expect(dirs.length).toBeGreaterThan(1);
  for (const dir of dirs) {
    const inside = resolve(dir, "rsi");
    const roots = loadWorkspaceRoots({ FERAL_WORKSPACE: inside } as NodeJS.ProcessEnv);
    expect(roots).not.toContain(inside);
  }
});

test("empty/whitespace segments never resolve to a root escape", () => {
  // `;;` or `; ;` must not inject cwd/root via an empty segment. Split by
  // path.delimiter (`;` Windows / `:` POSIX) — see the CI note in git history.
  const blank = [delimiter, delimiter].join(" ");
  const roots = loadWorkspaceRoots({ FERAL_WORKSPACE: ` ${blank} ` } as NodeJS.ProcessEnv);
  // Only scratch survives (every path-list segment was blank → filtered out).
  expect(roots).toEqual([SCRATCH]);
});
