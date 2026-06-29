/**
 * loadWorkspaceRoots — sandbox root resolution + self-protection wall.
 *
 * The security-relevant property: the agent gets broad file/shell access, but
 * a root that would expose ~/.feral (its own RSI repo, db, SOUL) is dropped.
 */
import { test, expect } from "bun:test";
import { resolve, delimiter, sep, parse } from "node:path";
import { homedir } from "node:os";
import { loadWorkspaceRoots } from "../src/index.ts";

const FERAL_HOME = resolve(homedir(), ".feral");
const SCRATCH = resolve(FERAL_HOME, "workspace");

test("explicit FERAL_WORKSPACE list is honored and scratch is always added", () => {
  const a = resolve("/tmp/proj-a");
  const b = resolve("/tmp/proj-b");
  const roots = loadWorkspaceRoots({ FERAL_WORKSPACE: [a, b].join(delimiter) } as NodeJS.ProcessEnv);
  expect(roots).toContain(a);
  expect(roots).toContain(b);
  expect(roots).toContain(SCRATCH); // dedicated owned workspace always present
});

test("a root that would expose ~/.feral is dropped (self-protection wall)", () => {
  // homedir() contains FERAL_HOME, so listing it as a root must be refused —
  // otherwise the agent could read/write its own brain.
  const roots = loadWorkspaceRoots({ FERAL_WORKSPACE: homedir() } as NodeJS.ProcessEnv);
  expect(roots).not.toContain(homedir());
  expect(roots).not.toContain(FERAL_HOME);
  // The scratch subdir under ~/.feral is the one allowed exception.
  expect(roots).toContain(SCRATCH);
  // No surviving root (except scratch) may overlap FERAL_HOME in either
  // direction — assert the property directly, not the implementation predicate.
  for (const r of roots) {
    if (r === SCRATCH || r.startsWith(SCRATCH + sep)) continue;
    const overlaps =
      r === FERAL_HOME ||
      r.startsWith(FERAL_HOME + sep) || // r inside the brain
      FERAL_HOME.startsWith(r.endsWith(sep) ? r : r + sep); // r contains the brain
    expect(overlaps).toBe(false);
  }
});

test("the filesystem root is dropped (trailing-separator wall bypass)", () => {
  // The drive root that actually CONTAINS the brain ("/" on POSIX, the home
  // drive's "C:\\" on Windows) — already ends in a separator. The old
  // `FERAL_HOME.startsWith(r + sep)` check produced a double-separator prefix
  // that never matched, so this root slipped the wall and exposed the whole
  // drive, brain included.
  const fsRoot = parse(FERAL_HOME).root;
  const roots = loadWorkspaceRoots({ FERAL_WORKSPACE: fsRoot } as NodeJS.ProcessEnv);
  expect(roots).not.toContain(fsRoot);
  expect(roots).toContain(SCRATCH); // scratch still present
});

test("a crafted list pointing INTO ~/.feral is dropped (descendant bypass)", () => {
  // Pointing the workspace at the RSI repo / agent db handed the agent its own
  // brain — the old wall only caught ancestors of FERAL_HOME, never descendants.
  const rsiRepo = resolve(FERAL_HOME, "rsi");
  const agentDir = resolve(FERAL_HOME, "agent");
  const realProject = resolve("/tmp/legit-project");
  const roots = loadWorkspaceRoots({
    FERAL_WORKSPACE: [rsiRepo, agentDir, realProject].join(delimiter),
  } as NodeJS.ProcessEnv);
  expect(roots).not.toContain(rsiRepo);
  expect(roots).not.toContain(agentDir);
  expect(roots).toContain(realProject); // a legit sibling root still survives
  expect(roots).toContain(SCRATCH);
});

test("empty/whitespace segments never resolve to a root escape", () => {
  // `;;` or `; ;` must not inject cwd/root via an empty segment. The
  // expected literal uses PATH-LIST SEPARATORS CORRECT FOR THE PLATFORM —
  // loadWorkspaceRoots splits by `path.delimiter`, which is `;` on Windows
  // and `:` on POSIX. A hard-coded `;` would split into a single element
  // on POSIX and the trailing whitespace would resolve() to cwd + garbage,
  // producing a phantom root that bypasses the wall. (Found by GitHub CI:
  // macos-latest + ubuntu-latest both failed because of this.)
  const blank = [delimiter, delimiter].join(" ");
  const roots = loadWorkspaceRoots({ FERAL_WORKSPACE: ` ${blank} ` } as NodeJS.ProcessEnv);
  // Only scratch survives (every path-list segment was blank → filtered out).
  expect(roots).toEqual([SCRATCH]);
});
