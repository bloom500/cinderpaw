/**
 * scan_workspace — ECC AgentShield-style security scanner.
 *
 * Scans the workspace for two categories of issues:
 *   1. Secrets: hardcoded API keys, passwords, tokens (detection only — never
 *      outputs the actual secret values, just file paths + line numbers)
 *   2. Code issues: eval(), innerHTML=, dangerouslySetInnerHTML, SQL injection
 *      patterns, and other common security anti-patterns
 *
 * Patterns are adapted from ECC's AgentShield security-audit.ts.
 * The tool reads files — it never writes or executes anything.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import type { Tool, ToolManifest } from "../../types.ts";

interface Finding {
  file: string;
  line: number;
  issue: string;
  category: "secret" | "code";
}

// ── Secret patterns (detect presence, never expose values) ───────────────────
const SECRET_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  { regex: /api[_-]?key\s*[:=]\s*['"][^'"]{16,}['"]/gi,    label: "Hardcoded API key" },
  { regex: /password\s*[:=]\s*['"][^'"]{4,}['"]/gi,         label: "Hardcoded password" },
  { regex: /secret\s*[:=]\s*['"][^'"]{8,}['"]/gi,           label: "Hardcoded secret" },
  { regex: /Bearer\s+[A-Za-z0-9\-_.]{20,}/g,                label: "Bearer token" },
  { regex: /sk-[a-zA-Z0-9]{32,}/g,                          label: "OpenAI API key" },
  { regex: /ghp_[a-zA-Z0-9]{36}/g,                          label: "GitHub personal access token" },
  { regex: /AIza[0-9A-Za-z\-_]{35}/g,                       label: "Google API key" },
  { regex: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/g,        label: "Private key" },
];

// ── Code security anti-patterns ───────────────────────────────────────────────
const CODE_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  { regex: /\beval\s*\(/g,                    label: "eval() — potential code injection" },
  { regex: /innerHTML\s*=/g,                  label: "innerHTML assignment — potential XSS" },
  { regex: /dangerouslySetInnerHTML/g,         label: "dangerouslySetInnerHTML — potential XSS" },
  { regex: /document\.write\s*\(/g,           label: "document.write() — potential XSS" },
  { regex: /\$\{[^}]+\}[^;,\n]*(?:sql|query)/gi, label: "Template literal in SQL — potential injection" },
  { regex: /child_process\.exec\s*\(/g,       label: "exec() with potential command injection" },
  { regex: /new\s+Function\s*\(/g,            label: "new Function() — potential code injection" },
];

// File extensions to scan
const SCAN_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".java", ".cs", ".rb", ".php",
  ".env", ".json", ".yaml", ".yml", ".toml",
]);

// Directories to skip entirely
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "target",
  "__pycache__", ".cache", "coverage",
]);

export function createScanWorkspaceTool(workspaceRoot: string): Tool {
  const manifest: ToolManifest = {
    name: "scan_workspace",
    description:
      "Scan the workspace for security issues: hardcoded secrets (API keys, passwords, " +
      "tokens) and code anti-patterns (eval, XSS vectors, injection risks). " +
      "Returns a report with file paths and line numbers. Never outputs secret values.",
    permissions: ["fs:read"],
    networkAccess: false,
    allowedPaths: [workspaceRoot],
  };

  return {
    manifest,
    parameters: {
      path: {
        type: "string",
        description: "Subdirectory to scan (relative to workspace root). Defaults to workspace root.",
        required: false,
      },
      category: {
        type: "string",
        description: "Which category to scan: 'secrets', 'code', or 'all' (default: 'all').",
        required: false,
      },
    },
    async execute(args) {
      const subpath = typeof args.path === "string" ? args.path.trim() : "";
      const category = typeof args.category === "string"
        ? args.category.trim().toLowerCase()
        : "all";

      const scanRoot = subpath ? join(workspaceRoot, subpath) : workspaceRoot;
      const findings: Finding[] = [];

      try {
        scanDir(
          scanRoot,
          workspaceRoot,
          findings,
          category === "secrets" || category === "all",
          category === "code"    || category === "all",
        );
      } catch (err) {
        return { ok: false, content: `Scan failed: ${String(err)}`, error: "scan_error" };
      }

      return {
        ok: true,
        content: formatReport(findings, scanRoot, workspaceRoot),
        data: { findings, scannedRoot: relative(workspaceRoot, scanRoot) || "." },
      };
    },
  };
}

// ── Scanner ───────────────────────────────────────────────────────────────────

function scanDir(
  dir: string,
  root: string,
  findings: Finding[],
  secrets: boolean,
  code: boolean,
  depth = 0,
): void {
  if (depth > 8) return;   // prevent runaway recursion in deeply nested repos

  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }

  for (const entry of entries) {
    if (entry.startsWith(".") && entry !== ".env") continue;
    if (SKIP_DIRS.has(entry)) continue;

    const full = join(dir, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }

    if (stat.isDirectory()) {
      scanDir(full, root, findings, secrets, code, depth + 1);
    } else if (stat.isFile() && SCAN_EXTENSIONS.has(extname(entry).toLowerCase())) {
      scanFile(full, root, findings, secrets, code);
    }
  }
}

function scanFile(
  file: string,
  root: string,
  findings: Finding[],
  checkSecrets: boolean,
  checkCode: boolean,
): void {
  let content: string;
  try { content = readFileSync(file, "utf8"); } catch { return; }

  // Skip large files (> 500 KB) to avoid memory spikes
  if (content.length > 512_000) return;

  const relPath = relative(root, file);
  const lines = content.split("\n");

  lines.forEach((line, i) => {
    const lineNum = i + 1;

    if (checkSecrets) {
      for (const { regex, label } of SECRET_PATTERNS) {
        regex.lastIndex = 0;
        if (regex.test(line)) {
          // Do NOT output the matched value — only location + category
          findings.push({ file: relPath, line: lineNum, issue: label, category: "secret" });
        }
      }
    }

    if (checkCode) {
      for (const { regex, label } of CODE_PATTERNS) {
        regex.lastIndex = 0;
        if (regex.test(line)) {
          findings.push({ file: relPath, line: lineNum, issue: label, category: "code" });
        }
      }
    }
  });
}

// ── Report formatter ──────────────────────────────────────────────────────────

function formatReport(findings: Finding[], scanRoot: string, root: string): string {
  const scanLabel = relative(root, scanRoot) || ".";

  if (findings.length === 0) {
    return `✅ No issues found in \`${scanLabel}\`.`;
  }

  const secrets = findings.filter((f) => f.category === "secret");
  const code    = findings.filter((f) => f.category === "code");
  const lines: string[] = [
    `## Security Scan: \`${scanLabel}\``,
    `Found **${findings.length}** issue(s): ${secrets.length} secret(s), ${code.length} code issue(s).`,
    "",
  ];

  if (secrets.length > 0) {
    lines.push("### 🔑 Potential Secrets");
    for (const f of secrets) {
      lines.push(`- \`${f.file}:${f.line}\` — ${f.issue}`);
    }
    lines.push("");
  }

  if (code.length > 0) {
    lines.push("### ⚠️ Code Issues");
    for (const f of code) {
      lines.push(`- \`${f.file}:${f.line}\` — ${f.issue}`);
    }
    lines.push("");
  }

  lines.push(
    "_Note: Secret values are never shown in this report — only locations._",
    "_Review each finding manually before taking action._",
  );

  return lines.join("\n");
}
