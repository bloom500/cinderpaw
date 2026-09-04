/**
 * Read-before-edit gate (read-ledger.ts).
 *
 * The failure this prevents is the expensive kind on an unattended run: the
 * agent rewrites a file it never opened, the tool reports success, and the
 * damage surfaces many steps later with the original context gone.
 *
 * The tests that matter most here are the NEGATIVE ones — the cases the gate
 * must NOT block, because a gate that fires on legitimate work gets routed
 * around and stops protecting anything: creating a new file, replaying an
 * idempotent write after a crash, and editing again right after your own edit.
 */

import { afterEach, beforeEach, expect, test, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEditFileTool } from "../src/tools/builtin/edit-file.ts";
import { createWriteFileTool } from "../src/tools/builtin/write-file.ts";
import { createReadFileTool } from "../src/tools/builtin/read-file.ts";
import { forgetSession } from "../src/tools/read-ledger.ts";
import type { ToolContext } from "../src/types.ts";

let tmp: string;
const SESSION = "read-gate-session";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cinderpaw-readgate-"));
  forgetSession(SESSION);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function ctxFor(paths: string[]): ToolContext {
  return {
    sessionId: SESSION,
    manifest: {
      name: "t",
      description: "t",
      permissions: ["fs:read", "fs:write"],
      networkAccess: false,
      allowedPaths: paths,
    },
    audit: () => {},
  } as unknown as ToolContext;
}

describe("editing a file the session never read", () => {
  test("edit_file refuses, and says which call unblocks it", async () => {
    const f = join(tmp, "a.txt");
    writeFileSync(f, "hello world\n");
    const res = await createEditFileTool([tmp]).execute(
      { path: f, old_string: "hello", new_string: "goodbye" },
      ctxFor([tmp]),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("unread_file");
    expect(res.content).toContain("read_file");
    // The file is untouched — a refused edit must not half-apply.
    expect(readFileSync(f, "utf8")).toBe("hello world\n");
  });

  test("write_file refuses to overwrite an existing unread file", async () => {
    const f = join(tmp, "b.txt");
    writeFileSync(f, "original content\n");
    const res = await createWriteFileTool([tmp]).execute(
      { path: f, content: "clobbered\n" },
      ctxFor([tmp]),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("unread_file");
    expect(readFileSync(f, "utf8")).toBe("original content\n");
  });

  test("read_file satisfies the gate", async () => {
    const f = join(tmp, "c.txt");
    writeFileSync(f, "hello world\n");
    const ctx = ctxFor([tmp]);
    await createReadFileTool([tmp]).execute({ path: f }, ctx);
    const res = await createEditFileTool([tmp]).execute(
      { path: f, old_string: "hello", new_string: "goodbye" },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(readFileSync(f, "utf8")).toBe("goodbye world\n");
  });

  test("the ledger is per-session — another session's read does not count", async () => {
    const f = join(tmp, "d.txt");
    writeFileSync(f, "hello\n");
    await createReadFileTool([tmp]).execute({ path: f }, ctxFor([tmp]));
    const other = { ...ctxFor([tmp]), sessionId: "a-different-session" };
    const res = await createEditFileTool([tmp]).execute(
      { path: f, old_string: "hello", new_string: "bye" },
      other,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("unread_file");
  });
});

describe("stale reads", () => {
  test("a file changed after the read is refused, not clobbered", async () => {
    const f = join(tmp, "e.txt");
    writeFileSync(f, "version one\n");
    const ctx = ctxFor([tmp]);
    await createReadFileTool([tmp]).execute({ path: f }, ctx);

    // Something else rewrites it — a build step, a parallel subagent.
    writeFileSync(f, "version two, written by someone else\n");
    utimesSync(f, new Date(Date.now() + 5000), new Date(Date.now() + 5000));

    const res = await createEditFileTool([tmp]).execute(
      { path: f, old_string: "version", new_string: "VERSION" },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("unread_file");
    expect(res.content).toContain("changed on disk");
    expect(readFileSync(f, "utf8")).toBe("version two, written by someone else\n");
  });

  test("re-reading clears the staleness", async () => {
    const f = join(tmp, "f.txt");
    writeFileSync(f, "one\n");
    const ctx = ctxFor([tmp]);
    await createReadFileTool([tmp]).execute({ path: f }, ctx);
    writeFileSync(f, "two\n");
    utimesSync(f, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    await createReadFileTool([tmp]).execute({ path: f }, ctx);
    const res = await createEditFileTool([tmp]).execute(
      { path: f, old_string: "two", new_string: "three" },
      ctx,
    );
    expect(res.ok).toBe(true);
  });
});

describe("what the gate must NOT block", () => {
  test("creating a new file needs no prior read", async () => {
    const f = join(tmp, "brand-new.txt");
    const res = await createWriteFileTool([tmp]).execute(
      { path: f, content: "fresh\n" },
      ctxFor([tmp]),
    );
    expect(res.ok).toBe(true);
    expect(readFileSync(f, "utf8")).toBe("fresh\n");
  });

  test("an agent may edit again straight after its own edit", async () => {
    const f = join(tmp, "g.txt");
    writeFileSync(f, "alpha beta\n");
    const ctx = ctxFor([tmp]);
    await createReadFileTool([tmp]).execute({ path: f }, ctx);
    const edit = createEditFileTool([tmp]);
    expect((await edit.execute({ path: f, old_string: "alpha", new_string: "A" }, ctx)).ok).toBe(true);
    // Its own write bumped the mtime; that must not read as "someone else".
    const second = await edit.execute({ path: f, old_string: "beta", new_string: "B" }, ctx);
    expect(second.ok).toBe(true);
    expect(readFileSync(f, "utf8")).toBe("A B\n");
  });

  test("write_file then edit_file on the same file works without re-reading", async () => {
    const f = join(tmp, "h.txt");
    const ctx = ctxFor([tmp]);
    await createWriteFileTool([tmp]).execute({ path: f, content: "x y\n" }, ctx);
    const res = await createEditFileTool([tmp]).execute(
      { path: f, old_string: "x", new_string: "z" },
      ctx,
    );
    expect(res.ok).toBe(true);
  });

  /**
   * The load-bearing one. Crash-resume replays writes in a FRESH process whose
   * ledger is empty. A replay whose content already matches disk must stay a
   * benign no-op — gating it would turn every resumed write into a hard
   * failure, breaking the walk-away recovery this gate exists to protect.
   */
  test("an idempotent replay after a crash is still a no-op, not a refusal", async () => {
    const f = join(tmp, "resumed.txt");
    writeFileSync(f, "already written by the pre-crash run\n");
    forgetSession(SESSION); // the restart lost the ledger
    const res = await createWriteFileTool([tmp]).execute(
      { path: f, content: "already written by the pre-crash run\n" },
      ctxFor([tmp]),
    );
    expect(res.ok).toBe(true);
    expect(res.content).toContain("Unchanged");
  });
});
