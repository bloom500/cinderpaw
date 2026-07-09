/**
 * File operations tests — edit_file, file_search, grep.
 *
 * Each test creates a temporary directory under the OS tmpdir, writes
 * a known set of files, runs the tool against it, and asserts on the
 * structured result.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createEditFileTool } from "../src/tools/builtin/edit-file.ts";
import { createFileSearchTool } from "../src/tools/builtin/file-search.ts";
import { createGrepTool } from "../src/tools/builtin/grep.ts";
import { resolveAllowedPath } from "../src/egress/tool-permissions.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { openDatabase } from "../src/db.ts";
import type { ToolContext } from "../src/types.ts";
import { RealProcessSandbox } from "../src/egress/process-sandbox.ts";
import { EgressProxy } from "../src/egress/egress-proxy.ts";

function makeCtx(allowedPaths: string[]): { ctx: ToolContext; cleanup: () => void } {
  // A real but throwaway DB so the AuditLog has somewhere to write.
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db.raw);
  const egress = new EgressProxy(audit.logger);
  const procSandbox = new RealProcessSandbox(audit.logger);
  // The ToolRegistry constructs the ctx; we mimic that here.
  const ctx: ToolContext = {
    sessionId: "test",
    manifest: {
      name: "test",
      description: "test",
      permissions: ["fs:read", "fs:write", "process:spawn"],
      networkAccess: false,
      allowedPaths,
      allowedExecutables: ["sh", "cmd"],
    },
    fetch: egress.forTool(
      {
        name: "test",
        description: "test",
        permissions: [],
        networkAccess: false,
      },
      "test",
    ),
    audit: audit.logger,
    process: procSandbox,
  };
  return {
    ctx,
    cleanup: () => db.close(),
  };
}

describe("resolveAllowedPath", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "feral-fs-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("accepts a path inside the allowed root", () => {
    const m = {
      name: "t", description: "t",
      permissions: ["fs:read"] as Array<"fs:read" | "fs:write" | "process:spawn" | "network:outbound">,
      networkAccess: false,
      allowedPaths: [tmp],
    };
    const inner = join(tmp, "sub", "file.txt");
    // realpath the root: on macOS tmpdir() lives behind the /var ->
    // /private/var symlink, so the resolver returns the canonical form.
    expect(resolveAllowedPath(m, "fs:read", inner)).toBe(
      join(realpathSync(tmp), "sub", "file.txt"),
    );
  });

  it("rejects a path that escapes the allowed root", () => {
    const m = {
      name: "t", description: "t",
      permissions: ["fs:read"] as Array<"fs:read" | "fs:write" | "process:spawn" | "network:outbound">,
      networkAccess: false,
      allowedPaths: [tmp],
    };
    expect(() => resolveAllowedPath(m, "fs:read", join(tmp, "..", "etc", "passwd")))
      .toThrow();
  });
});

describe("edit_file", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "feral-edit-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("replaces a unique occurrence of old_string", async () => {
    const f = join(tmp, "hello.txt");
    writeFileSync(f, "Hello world!\nThis is feral.\n");
    const tool = createEditFileTool([tmp]);
    const { ctx, cleanup } = makeCtx([tmp]);
    try {
      const result = await tool.execute(
        { path: f, old_string: "world", new_string: "Feral" },
        ctx,
      );
      expect(result.ok).toBe(true);
      const after = await Bun.file(f).text();
      expect(after).toBe("Hello Feral!\nThis is feral.\n");
    } finally { cleanup(); }
  });

  it("fails when old_string is not unique and replace_all is false", async () => {
    const f = join(tmp, "dup.txt");
    writeFileSync(f, "foo bar foo baz foo\n");
    const tool = createEditFileTool([tmp]);
    const { ctx, cleanup } = makeCtx([tmp]);
    try {
      const result = await tool.execute(
        { path: f, old_string: "foo", new_string: "FOO" },
        ctx,
      );
      expect(result.ok).toBe(false);
      expect(result.error).toBe("ambiguous_match");
    } finally { cleanup(); }
  });

  it("replaces every occurrence with replace_all=true", async () => {
    const f = join(tmp, "dup.txt");
    writeFileSync(f, "foo bar foo baz foo\n");
    const tool = createEditFileTool([tmp]);
    const { ctx, cleanup } = makeCtx([tmp]);
    try {
      const result = await tool.execute(
        { path: f, old_string: "foo", new_string: "FOO", replace_all: true },
        ctx,
      );
      expect(result.ok).toBe(true);
      const after = await Bun.file(f).text();
      expect(after).toBe("FOO bar FOO baz FOO\n");
    } finally { cleanup(); }
  });

  it("fails when old_string is missing entirely", async () => {
    const f = join(tmp, "missing.txt");
    writeFileSync(f, "alpha\n");
    const tool = createEditFileTool([tmp]);
    const { ctx, cleanup } = makeCtx([tmp]);
    try {
      const result = await tool.execute(
        { path: f, old_string: "omega", new_string: "beta" },
        ctx,
      );
      expect(result.ok).toBe(false);
      expect(result.error).toBe("not_found");
    } finally { cleanup(); }
  });

  it("blocks edits outside allowedPaths", async () => {
    const other = mkdtempSync(join(tmpdir(), "feral-other-"));
    try {
      const f = join(other, "secret.txt");
      writeFileSync(f, "top secret\n");
      const tool = createEditFileTool([tmp]); // tmp is the allowed root, NOT other
      const { ctx, cleanup } = makeCtx([tmp]);
      try {
        const result = await tool.execute(
          { path: f, old_string: "top", new_string: "bottom" },
          ctx,
        );
        expect(result.ok).toBe(false);
        // resolveAllowedPath throws PermissionDeniedError which the registry
        // converts; the tool sees it as a generic error.
        expect(existsSync(f)).toBe(true); // untouched
      } finally { cleanup(); }
    } finally { rmSync(other, { recursive: true, force: true }); }
  });
});

describe("file_search", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "feral-fs-"));
    // Build a small fixture tree.
    mkdirSync(join(tmp, "src", "tools"), { recursive: true });
    mkdirSync(join(tmp, "src", "core"), { recursive: true });
    writeFileSync(join(tmp, "src", "index.ts"), "// index\n");
    writeFileSync(join(tmp, "src", "tools", "registry.ts"), "// registry\n");
    writeFileSync(join(tmp, "src", "tools", "list.ts"), "// list\n");
    writeFileSync(join(tmp, "src", "core", "loop.ts"), "// loop\n");
    writeFileSync(join(tmp, "README.md"), "# readme\n");
  });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("finds all .ts files under src/**", async () => {
    const tool = createFileSearchTool([tmp]);
    const { ctx, cleanup } = makeCtx([tmp]);
    try {
      const result = await tool.execute(
        { pattern: "src/**/*.ts", path: tmp },
        ctx,
      );
      expect(result.ok).toBe(true);
      const data = result.data as { results: { path: string }[] };
      const names = data.results.map((r) => r.path.split(/[\\/]/).pop());
      expect(names.sort()).toEqual(["index.ts", "list.ts", "loop.ts", "registry.ts"]);
    } finally { cleanup(); }
  });

  it("finds a single specific file", async () => {
    const tool = createFileSearchTool([tmp]);
    const { ctx, cleanup } = makeCtx([tmp]);
    try {
      const result = await tool.execute(
        { pattern: "README.md", path: tmp },
        ctx,
      );
      expect(result.ok).toBe(true);
      const data = result.data as { results: { path: string }[] };
      expect(data.results.length).toBe(1);
    } finally { cleanup(); }
  });

  it("returns an empty list when nothing matches", async () => {
    const tool = createFileSearchTool([tmp]);
    const { ctx, cleanup } = makeCtx([tmp]);
    try {
      const result = await tool.execute(
        { pattern: "*.py", path: tmp },
        ctx,
      );
      expect(result.ok).toBe(true);
      const data = result.data as { results: unknown[] };
      expect(data.results).toEqual([]);
    } finally { cleanup(); }
  });

  it("blocks searches outside allowedPaths", async () => {
    const other = mkdtempSync(join(tmpdir(), "feral-other-"));
    try {
      const tool = createFileSearchTool([tmp]);
      const { ctx, cleanup } = makeCtx([tmp]);
      try {
        const result = await tool.execute(
          { pattern: "*", path: other },
          ctx,
        );
        expect(result.ok).toBe(false);
      } finally { cleanup(); }
    } finally { rmSync(other, { recursive: true, force: true }); }
  });
});

describe("grep", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "feral-grep-"));
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "src", "a.ts"), "const feral = 1;\nconst other = 2;\n");
    writeFileSync(join(tmp, "src", "b.ts"), "const FERAL = 'cap';\n");
    writeFileSync(join(tmp, "src", "c.txt"), "no code here\n");
  });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("finds case-sensitive matches across files", async () => {
    const tool = createGrepTool([tmp]);
    const { ctx, cleanup } = makeCtx([tmp]);
    try {
      const result = await tool.execute(
        { pattern: "feral", path: tmp, context_lines: 0 },
        ctx,
      );
      expect(result.ok).toBe(true);
      const data = result.data as { matches: { file: string; line: number }[] };
      // Should match a.ts:1 only (FERAL in b.ts is case-different).
      expect(data.matches.length).toBe(1);
      expect(data.matches[0]?.file).toMatch(/a\.ts$/);
    } finally { cleanup(); }
  });

  it("respects the glob filter on file names", async () => {
    const tool = createGrepTool([tmp]);
    const { ctx, cleanup } = makeCtx([tmp]);
    try {
      const result = await tool.execute(
        { pattern: "F", path: tmp, glob: "*.ts" },
        ctx,
      );
      expect(result.ok).toBe(true);
      const data = result.data as { matches: { file: string }[] };
      const files = new Set(data.matches.map((m) => m.file));
      // c.txt should NOT be in the results.
      for (const f of files) expect(f).not.toMatch(/c\.txt$/);
    } finally { cleanup(); }
  });

  it("rejects an invalid regex", async () => {
    const tool = createGrepTool([tmp]);
    const { ctx, cleanup } = makeCtx([tmp]);
    try {
      const result = await tool.execute(
        { pattern: "[unterminated", path: tmp },
        ctx,
      );
      expect(result.ok).toBe(false);
      expect(result.error).toBe("bad_args");
    } finally { cleanup(); }
  });
});
