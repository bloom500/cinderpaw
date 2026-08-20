/**
 * Code-quality tools (F7) — five narrow wrappers around the project's
 * dev workflow. Each tool auto-detects the project type from its manifest
 * file and runs the appropriate command.
 *
 * Tools (all share the same factory):
 *   - run_tests     → npm test / cargo test / pytest / go test / make test
 *   - format_code   → prettier / cargo fmt / black / gofmt / make format
 *   - lint_code     → eslint / cargo clippy / ruff / golangci-lint / make lint
 *   - install_deps  → npm install / cargo build / pip install / go mod download
 *   - build_project → npm run build / cargo build / go build / make build
 *
 * Security model: same as shell_exec — process:spawn permission, allowed
 * executables resolved at module load (F0.5 hardening), cwd contained in
 * the tool's allowed paths (typically the workspace), output capped at
 * the sandbox limit.
 *
 * Auto-detection is intentionally simple: it picks the FIRST manifest
 * file it sees, in a fixed priority order. If a project has both
 * `package.json` and a `Makefile`, node wins. The user can override the
 * detected type via the `project_type` parameter.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Tool, ToolManifest, ToolResult } from "../../types.ts";
import { resolveExecutables } from "../../core/executables.ts";

// Resolve the executables we need at module load (F0.5 hardening).
// npm/npx, cargo, pytest/python -m, go, make. On Windows, npm and npx
// resolve via PATHEXT.
const NODE_EXECS = resolveExecutables(["npm", "npx"]);
const RUST_EXECS = resolveExecutables(["cargo"]);
const PYTHON_EXECS = resolveExecutables(["python", "pytest", "black", "ruff", "pip"]);
const GO_EXECS = resolveExecutables(["go", "gofmt", "golangci-lint"]);
const MAKE_EXECS = resolveExecutables(["make"]);

export type ProjectType = "node" | "rust" | "python" | "go" | "make" | "unknown";

export type CodeQualityKind =
  | "run_tests"
  | "format_code"
  | "lint_code"
  | "install_deps"
  | "build_project";

const PROJECT_MANIFESTS: Array<{ type: ProjectType; files: string[] }> = [
  { type: "node", files: ["package.json"] },
  { type: "rust", files: ["Cargo.toml"] },
  { type: "python", files: ["pyproject.toml", "requirements.txt", "setup.py"] },
  { type: "go", files: ["go.mod"] },
  { type: "make", files: ["Makefile"] },
];

/**
 * Detect the project type by scanning for a manifest file in the given
 * directory. Returns "unknown" if no recognized manifest is present.
 *
 * Detection is purely a presence check on the FILENAME — we do not parse
 * the manifest. Cheap and predictable.
 */
export function detectProjectType(projectDir: string): ProjectType {
  for (const { type, files } of PROJECT_MANIFESTS) {
    for (const f of files) {
      if (existsSync(join(projectDir, f))) return type;
    }
  }
  return "unknown";
}

/**
 * Resolve the [executable, ...args] to run for a given (kind, projectType)
 * pair. Returns null if the kind is not supported for the project type.
 */
function commandFor(kind: CodeQualityKind, projectType: ProjectType): string[] | null {
  if (projectType === "node") {
    const npm = NODE_EXECS[0] ?? "npm";
    const npx = NODE_EXECS[1] ?? "npx";
    switch (kind) {
      case "run_tests":     return [npm, "test", "--"];
      case "format_code":   return [npx, "prettier", "--write", "."];
      case "lint_code":     return [npx, "eslint", "."];
      case "install_deps":  return [npm, "install"];
      case "build_project": return [npm, "run", "build"];
    }
  }
  if (projectType === "rust") {
    const cargo = RUST_EXECS[0] ?? "cargo";
    switch (kind) {
      case "run_tests":     return [cargo, "test"];
      case "format_code":   return [cargo, "fmt"];
      case "lint_code":     return [cargo, "clippy"];
      case "install_deps":  return [cargo, "build"]; // no separate install in cargo
      case "build_project": return [cargo, "build"];
    }
  }
  if (projectType === "python") {
    const py = PYTHON_EXECS[0] ?? "python";
    const pytest = PYTHON_EXECS[1] ?? "pytest";
    // PYTHON_EXECS[2] is black — kept in the exec list for env detection,
    // but formatting goes through ruff.
    const ruff = PYTHON_EXECS[3] ?? "ruff";
    const pip = PYTHON_EXECS[4] ?? "pip";
    switch (kind) {
      case "run_tests":     return [pytest];
      case "format_code":   return [ruff, "format", "."];
      case "lint_code":     return [ruff, "check", "."];
      case "install_deps":  return [pip, "install", "-r", "requirements.txt"];
      case "build_project": return [py, "-m", "build"];
    }
  }
  if (projectType === "go") {
    const go = GO_EXECS[0] ?? "go";
    const gofmt = GO_EXECS[1] ?? "gofmt";
    const golangci = GO_EXECS[2] ?? "golangci-lint";
    switch (kind) {
      case "run_tests":     return [go, "test", "./..."];
      case "format_code":   return [gofmt, "-w", "."];
      case "lint_code":     return [golangci, "run"];
      case "install_deps":  return [go, "mod", "download"];
      case "build_project": return [go, "build", "./..."];
    }
  }
  if (projectType === "make") {
    const make = MAKE_EXECS[0] ?? "make";
    switch (kind) {
      case "run_tests":     return [make, "test"];
      case "format_code":   return [make, "format"];
      case "lint_code":     return [make, "lint"];
      case "install_deps":  return [make, "install"];
      case "build_project": return [make, "build"];
    }
  }
  return null;
}

/** Read a script command from package.json's "scripts" section. */
function readNodeScript(projectDir: string, name: string): string | null {
  const path = join(projectDir, "package.json");
  if (!existsSync(path)) return null;
  try {
    const pkg = JSON.parse(readFileSync(path, "utf-8")) as {
      scripts?: Record<string, string>;
    };
    return pkg.scripts?.[name] ?? null;
  } catch {
    return null;
  }
}

const KIND_DESCRIPTIONS: Record<CodeQualityKind, string> = {
  run_tests:
    "Run the project's test suite. Auto-detects the project type (Node, " +
    "Rust, Python, Go, Make) and runs the corresponding command. Use " +
    "`project_type` to override the auto-detected type.",
  format_code:
    "Format the project's source code using the project's standard " +
    "formatter (prettier / cargo fmt / ruff format / gofmt / make format).",
  lint_code:
    "Lint the project's source code (eslint / cargo clippy / ruff / " +
    "golangci-lint / make lint).",
  install_deps:
    "Install the project's dependencies (npm install / cargo build / " +
    "pip install -r requirements.txt / go mod download / make install).",
  build_project:
    "Build the project (npm run build / cargo build / go build / " +
    "make build).",
};

/**
 * Factory: create one of the 5 code-quality tools. The `kind` parameter
 * determines the tool's name, description, and the command matrix it
 * applies against the detected project type.
 */
export function createCodeQualityTool(
  kind: CodeQualityKind,
  allowedPaths: string[],
): Tool {
  // Combine all possible executables into one allowlist. The sandbox matches
  // by basename, so the union is the safe path.
  const allExecs = Array.from(
    new Set([
      ...NODE_EXECS,
      ...RUST_EXECS,
      ...PYTHON_EXECS,
      ...GO_EXECS,
      ...MAKE_EXECS,
    ]),
  );

  const manifest: ToolManifest = {
    name: kind,
    description: KIND_DESCRIPTIONS[kind],
    permissions: ["process:spawn", "fs:read", "fs:write"],
    networkAccess: false,
    allowedPaths,
    allowedExecutables: allExecs,
  };

  return {
    manifest,
    parameters: {
      project_path: {
        type: "string",
        description:
          "Absolute path to the project root. Must be inside the tool's " +
          "allowed paths (typically the workspace).",
        required: true,
      },
      project_type: {
        type: "string",
        description:
          'Override auto-detection. One of "node", "rust", "python", "go", "make".',
        required: false,
      },
      extra_args: {
        type: "string",
        description:
          "Optional extra arguments appended to the auto-detected command " +
          "(e.g. '--watch' for tests, '--check' for format).",
        required: false,
      },
    },
    async execute(args, ctx): Promise<ToolResult> {
      if (!ctx.process) {
        return { ok: false, content: `${kind}: process sandbox unavailable`, error: "no_sandbox" };
      }
      const projectPath = args.project_path;
      if (typeof projectPath !== "string" || !projectPath.trim()) {
        return { ok: false, content: `${kind} requires a 'project_path' string.`, error: "bad_args" };
      }
      const overrideType = typeof args.project_type === "string" ? args.project_type : null;
      const extraArgs = typeof args.extra_args === "string" && args.extra_args.trim()
        ? args.extra_args.split(/\s+/).filter(Boolean)
        : [];

      const detected = detectProjectType(projectPath);
      const projectType = (overrideType as ProjectType | null) ?? detected;
      if (projectType === "unknown" && !overrideType) {
        return {
          ok: false,
          content: `${kind}: no project manifest found in "${projectPath}" ` +
            `(looked for package.json, Cargo.toml, pyproject.toml, requirements.txt, ` +
            `go.mod, Makefile). Pass "project_type" to override.`,
          error: "unknown_project",
        };
      }

      let cmd = commandFor(kind, projectType);
      if (!cmd) {
        return {
          ok: false,
          content: `${kind}: no command for project_type "${projectType}"`,
          error: "unsupported_kind",
        };
      }

      // For Node, prefer the project's own "scripts" entry when present.
      if (projectType === "node") {
        const script = readNodeScript(projectPath, kind === "run_tests" ? "test" : kind === "lint_code" ? "lint" : kind === "format_code" ? "format" : kind === "build_project" ? "build" : "");
        if (script) {
          // The sandbox's executable is npm; the script is the rest of argv.
          const npm = NODE_EXECS[0] ?? "npm";
          cmd = [npm, "run", kind === "run_tests" ? "test" : kind === "build_project" ? "build" : (kind === "format_code" ? "format" : "lint")];
        }
      }

      if (extraArgs.length > 0) cmd = cmd.concat(extraArgs);

      try {
        const result = await ctx.process.run(ctx.manifest, ctx.sessionId, {
          executable: cmd[0]!,
          args: cmd.slice(1),
          cwd: projectPath,
        });
        const ok = result.exitCode === 0 && !result.timedOut;
        const header = `$ ${cmd.join(" ")}\n` +
          `  (cwd: ${projectPath}, type: ${projectType})\n` +
          `[exit ${result.exitCode}` +
          (result.timedOut ? ", timed out" : "") +
          (result.outputTruncated ? ", output truncated" : "") +
          `, ${result.durationMs}ms]`;
        const out = result.stdout ? `\n${result.stdout}` : "";
        const err = result.stderr ? `\n[stderr]\n${result.stderr}` : "";
        return {
          ok,
          content: `${header}${out}${err}`,
          data: {
            exitCode: result.exitCode,
            projectType,
            command: cmd,
            stdout: result.stdout,
            stderr: result.stderr,
            durationMs: result.durationMs,
            timedOut: result.timedOut,
            outputTruncated: result.outputTruncated,
          },
        };
      } catch (err) {
        return {
          ok: false,
          content: `${kind} failed: ${String((err as Error).message ?? err)}`,
          error: "spawn_error",
        };
      }
    },
  };
}
