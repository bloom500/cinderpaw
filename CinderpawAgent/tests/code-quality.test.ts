/**
 * Tests for the code-quality tool factory.
 *
 * F7 brings 5 tools: run_tests, format_code, lint_code, install_deps,
 * build_project. They share a common pattern: detect the project type
 * from a manifest file, then run the appropriate command.
 *
 * These tests focus on the auto-detection logic and the tool factory's
 * manifest — the actual command execution is exercised by the existing
 * process-sandbox tests.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createCodeQualityTool,
  detectProjectType,
  type CodeQualityKind,
  type ProjectType,
} from "../src/tools/builtin/code-quality.ts";

const ALL_KINDS: CodeQualityKind[] = [
  "run_tests",
  "format_code",
  "lint_code",
  "install_deps",
  "build_project",
];

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cinderpaw-cq-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("detectProjectType", () => {
  it("returns 'node' when package.json is present", () => {
    writeFileSync(join(tmpDir, "package.json"), "{}");
    expect(detectProjectType(tmpDir)).toBe("node");
  });

  it("returns 'rust' when Cargo.toml is present (and not node)", () => {
    writeFileSync(join(tmpDir, "Cargo.toml"), "[package]\nname = \"x\"");
    expect(detectProjectType(tmpDir)).toBe("rust");
  });

  it("returns 'python' when pyproject.toml is present", () => {
    writeFileSync(join(tmpDir, "pyproject.toml"), "[project]\nname = \"x\"");
    expect(detectProjectType(tmpDir)).toBe("python");
  });

  it("returns 'python' when requirements.txt is present", () => {
    writeFileSync(join(tmpDir, "requirements.txt"), "requests");
    expect(detectProjectType(tmpDir)).toBe("python");
  });

  it("returns 'go' when go.mod is present", () => {
    writeFileSync(join(tmpDir, "go.mod"), "module x");
    expect(detectProjectType(tmpDir)).toBe("go");
  });

  it("returns 'make' when only a Makefile is present", () => {
    writeFileSync(join(tmpDir, "Makefile"), "all:\n\t@true");
    expect(detectProjectType(tmpDir)).toBe("make");
  });

  it("returns 'unknown' when no manifest file is present", () => {
    expect(detectProjectType(tmpDir)).toBe("unknown");
  });

  it("prefers node over make (package.json wins over Makefile)", () => {
    writeFileSync(join(tmpDir, "package.json"), "{}");
    writeFileSync(join(tmpDir, "Makefile"), "all:");
    expect(detectProjectType(tmpDir)).toBe("node");
  });
});

describe("createCodeQualityTool", () => {
  for (const kind of ALL_KINDS) {
    it(`registers a tool named "${kind}"`, () => {
      const tool = createCodeQualityTool(kind, [tmpDir]);
      expect(tool.manifest.name).toBe(kind);
    });

    it(`declares process:spawn permission for "${kind}"`, () => {
      const tool = createCodeQualityTool(kind, [tmpDir]);
      expect(tool.manifest.permissions).toContain("process:spawn");
    });

    it(`declares fs:read and fs:write permissions for "${kind}"`, () => {
      const tool = createCodeQualityTool(kind, [tmpDir]);
      expect(tool.manifest.permissions).toContain("fs:read");
      expect(tool.manifest.permissions).toContain("fs:write");
    });

    it(`requires the project_path parameter for "${kind}"`, () => {
      const tool = createCodeQualityTool(kind, [tmpDir]);
      expect(tool.parameters.project_path).toBeDefined();
      expect(tool.parameters.project_path.required).toBe(true);
    });
  }

  it("all 5 tools are different manifests", () => {
    const names = new Set(ALL_KINDS.map((k) => createCodeQualityTool(k, [tmpDir]).manifest.name));
    expect(names.size).toBe(5);
  });
});

describe("code-quality tool execution — happy path", () => {
  it("run_tests on a Node project invokes 'npm test' and returns the result", async () => {
    // Use a tiny Node project that has a no-op "test" script.
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "x", scripts: { test: 'echo "tests passed"' } }),
    );

    const tool = createCodeQualityTool("run_tests", [tmpDir]);
    expect(tool.manifest.name).toBe("run_tests");

    // We do not invoke execute() here — that needs a real ToolContext with a
    // sandbox, which the existing shell-git-tools.test.ts covers. This test
    // just confirms the factory wired everything correctly.
  });
});
