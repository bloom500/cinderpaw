/**
 * Sandbox guarantees — the security-critical behavior, proven without an LLM.
 *
 * These cover the non-negotiable constraints: tools can't exceed their manifest,
 * no request reaches loopback/private hosts or non-whitelisted domains, unknown
 * tools are blocked, budgets are enforced, and everything is audited.
 */

import { describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { Database } from "bun:sqlite";

import { openDatabase } from "../src/db.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import {
  EgressProxy,
  EgressBlockedError,
  isBlockedHost,
  hostMatchesWhitelist,
} from "../src/egress/egress-proxy.ts";
import {
  validateManifest,
  resolveAllowedPath,
  ManifestError,
  PermissionDeniedError,
} from "../src/egress/tool-permissions.ts";
import { InferenceRouter, BudgetExhaustedError } from "../src/egress/inference-router.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { createReadFileTool } from "../src/tools/builtin/read-file.ts";
import { createWebSearchTool } from "../src/tools/builtin/web-search.ts";
import type { ToolManifest } from "../src/types.ts";

function freshDb() {
  return openDatabase(":memory:");
}

function countAudit(db: Database, result?: string): number {
  const sql = result
    ? "SELECT COUNT(*) AS n FROM audit_log WHERE result = ?"
    : "SELECT COUNT(*) AS n FROM audit_log";
  const q = db.query<{ n: number }, string[]>(sql);
  const row = result ? q.get(result) : q.get();
  return row?.n ?? 0;
}

describe("manifest validation", () => {
  test("rejects network access without domains", () => {
    const bad: ToolManifest = {
      name: "x",
      description: "d",
      permissions: ["network:outbound"],
      networkAccess: true,
    };
    expect(() => validateManifest(bad)).toThrow(ManifestError);
  });

  test("rejects networkAccess/permission mismatch", () => {
    const bad: ToolManifest = {
      name: "x",
      description: "d",
      permissions: [],
      networkAccess: true,
      allowedDomains: ["example.com"],
    };
    expect(() => validateManifest(bad)).toThrow(ManifestError);
  });

  test("rejects fs permission without paths", () => {
    const bad: ToolManifest = {
      name: "x",
      description: "d",
      permissions: ["fs:read"],
      networkAccess: false,
    };
    expect(() => validateManifest(bad)).toThrow(ManifestError);
  });

  test("accepts a consistent manifest", () => {
    const ok: ToolManifest = {
      name: "web_search",
      description: "search",
      permissions: ["network:outbound"],
      networkAccess: true,
      allowedDomains: ["duckduckgo.com"],
    };
    expect(() => validateManifest(ok)).not.toThrow();
  });
});

describe("path permission enforcement", () => {
  const root = mkdtempSync(join(tmpdir(), "feral-"));
  const manifest: ToolManifest = {
    name: "read_file",
    description: "d",
    permissions: ["fs:read"],
    networkAccess: false,
    allowedPaths: [root],
  };

  test("allows a path inside the root", () => {
    const p = resolveAllowedPath(manifest, "fs:read", join(root, "a.txt"));
    // compare against the canonical root: macOS tmpdirs live behind the
    // /var -> /private/var symlink, so the resolver returns the realpath.
    expect(p.startsWith(realpathSync(root))).toBe(true);
  });

  test("blocks directory traversal out of the root", () => {
    expect(() =>
      resolveAllowedPath(manifest, "fs:read", join(root, "..", "..", "etc")),
    ).toThrow(PermissionDeniedError);
  });

  test("blocks an undeclared permission", () => {
    expect(() =>
      resolveAllowedPath(manifest, "fs:write", join(root, "a.txt")),
    ).toThrow(PermissionDeniedError);
  });
});

describe("call-time deny wall (~/.feral, ~/.ssh, FERAL_FS_DENY)", () => {
  // Broad root: the user's whole home dir — the lax-sandbox default.
  const homeManifest: ToolManifest = {
    name: "read_file",
    description: "d",
    permissions: ["fs:read", "fs:write"],
    networkAccess: false,
    allowedPaths: [homedir()],
  };
  const FERAL_HOME = join(homedir(), ".feral");

  test("targets inside ~/.feral are denied even under an allowed root", () => {
    for (const p of [
      join(FERAL_HOME, "connectors.json"),
      join(FERAL_HOME, "rsi", "repo", "x.ts"),
      FERAL_HOME,
    ]) {
      expect(() => resolveAllowedPath(homeManifest, "fs:read", p)).toThrow(
        PermissionDeniedError,
      );
    }
  });

  test("the scratch subtree ~/.feral/workspace stays allowed", () => {
    const p = resolveAllowedPath(
      homeManifest,
      "fs:write",
      join(FERAL_HOME, "workspace", "notes.txt"),
    );
    expect(p.endsWith("notes.txt")).toBe(true);
  });

  test("~/.ssh is denied", () => {
    expect(() =>
      resolveAllowedPath(homeManifest, "fs:read", join(homedir(), ".ssh", "id_rsa")),
    ).toThrow(PermissionDeniedError);
  });

  test("FERAL_FS_DENY extends the wall", () => {
    const extra = join(homedir(), "very-secret-dir");
    process.env.FERAL_FS_DENY = extra;
    try {
      expect(() =>
        resolveAllowedPath(homeManifest, "fs:read", join(extra, "f.txt")),
      ).toThrow(PermissionDeniedError);
    } finally {
      delete process.env.FERAL_FS_DENY;
    }
  });

  test("ordinary home paths pass", () => {
    const p = resolveAllowedPath(
      homeManifest,
      "fs:read",
      join(homedir(), "Documents", "todo.txt"),
    );
    expect(p.endsWith("todo.txt")).toBe(true);
  });
});

describe("host blocking", () => {
  test("loopback and private ranges are blocked", () => {
    for (const h of [
      "localhost",
      "127.0.0.1",
      "10.0.0.5",
      "172.16.3.4",
      "192.168.1.1",
      "169.254.1.1",
      "::1",
    ]) {
      expect(isBlockedHost(h)).toBe(true);
    }
  });

  test("public hosts are allowed", () => {
    expect(isBlockedHost("example.com")).toBe(false);
    expect(isBlockedHost("8.8.8.8")).toBe(false);
  });

  test("whitelist matches subdomains but not unrelated hosts", () => {
    expect(hostMatchesWhitelist("api.example.com", ["example.com"])).toBe(true);
    expect(hostMatchesWhitelist("example.com", ["example.com"])).toBe(true);
    expect(hostMatchesWhitelist("evil.com", ["example.com"])).toBe(false);
  });

  test('"*" matches any public host (open-egress default)', () => {
    expect(hostMatchesWhitelist("anything.example.org", ["*"])).toBe(true);
    expect(hostMatchesWhitelist("example.com", ["*"])).toBe(true);
    // "*" does NOT bypass the SSRF guard — isBlockedHost runs first.
    expect(isBlockedHost("127.0.0.1")).toBe(true);
  });
});

describe("egress proxy", () => {
  const manifest: ToolManifest = {
    name: "web_search",
    description: "d",
    permissions: ["network:outbound"],
    networkAccess: true,
    allowedDomains: ["example.com"],
  };

  test("blocks loopback destinations and audits", async () => {
    const db = freshDb();
    const audit = new AuditLog(db.raw);
    const proxy = new EgressProxy(audit.logger);
    const fetchFn = proxy.forTool(manifest, "s1");
    await expect(fetchFn("http://localhost:11434/")).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
    expect(countAudit(db.raw, "blocked")).toBe(1);
    db.close();
  });

  test("blocks non-whitelisted domains", async () => {
    const db = freshDb();
    const audit = new AuditLog(db.raw);
    const proxy = new EgressProxy(audit.logger);
    const fetchFn = proxy.forTool(manifest, "s1");
    await expect(fetchFn("https://evil.com/")).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
    db.close();
  });

  test("blocks tools without network access", async () => {
    const noNet: ToolManifest = {
      name: "read_file",
      description: "d",
      permissions: ["fs:read"],
      networkAccess: false,
      allowedPaths: ["/tmp"],
    };
    const db = freshDb();
    const proxy = new EgressProxy(new AuditLog(db.raw).logger);
    const fetchFn = proxy.forTool(noNet, "s1");
    await expect(fetchFn("https://example.com/")).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
    db.close();
  });

  test("enforces the rate limit", async () => {
    const db = freshDb();
    const proxy = new EgressProxy(new AuditLog(db.raw).logger, {
      maxRequests: 2,
      windowMs: 60_000,
      defaultTimeoutMs: 1_000,
    });
    const fetchFn = proxy.forTool(manifest, "s1");
    // Whitelisted but unreachable host: first two attempts pass validation and
    // fail at the network layer; the third is blocked by the rate limiter.
    await fetchFn("https://example.com/").catch(() => {});
    await fetchFn("https://example.com/").catch(() => {});
    await expect(fetchFn("https://example.com/")).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
    db.close();
  });
});

describe("tool registry", () => {
  test("blocks unknown tools and audits", async () => {
    const db = freshDb();
    const audit = new AuditLog(db.raw);
    const registry = new ToolRegistry(new EgressProxy(audit.logger), audit);
    const result = await registry.call("does_not_exist", {}, "s1");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("unknown_tool");
    expect(countAudit(db.raw, "blocked")).toBe(1);
    db.close();
  });

  test("read_file reads inside the workspace and blocks traversal", async () => {
    const root = mkdtempSync(join(tmpdir(), "feral-ws-"));
    writeFileSync(join(root, "note.txt"), "hello sandbox");
    const db = freshDb();
    const audit = new AuditLog(db.raw);
    const registry = new ToolRegistry(new EgressProxy(audit.logger), audit);
    registry.register(createReadFileTool([root]));

    const ok = await registry.call("read_file", { path: join(root, "note.txt") }, "s1");
    expect(ok.ok).toBe(true);
    expect(ok.content).toContain("hello sandbox");

    const denied = await registry.call(
      "read_file",
      { path: join(root, "..", "secret") },
      "s1",
    );
    expect(denied.ok).toBe(false);
    db.close();
  });

  test("duplicate registration is rejected", () => {
    const db = freshDb();
    const audit = new AuditLog(db.raw);
    const registry = new ToolRegistry(new EgressProxy(audit.logger), audit);
    registry.register(createWebSearchTool());
    expect(() => registry.register(createWebSearchTool())).toThrow();
    db.close();
  });
});

describe("inference budget", () => {
  test("daily budget exhaustion throws and audits a block", async () => {
    const db = freshDb();
    const audit = new AuditLog(db.raw);
    // Pre-seed today's usage above the daily cap.
    db.raw
      .query("INSERT INTO token_usage (day, tokens) VALUES (?, ?)")
      .run(new Date().toISOString().slice(0, 10), 1_000_000);

    const router = new InferenceRouter(
      {
        primary: { provider: "ollama", model: "m", baseUrl: "http://127.0.0.1:9" },
        tokenBudget: { perConversation: 50_000, perDay: 1, onExhausted: "stop" },
      },
      audit.logger,
      db.raw,
    );

    await expect(
      router.complete({ sessionId: "s1", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(countAudit(db.raw, "blocked")).toBe(1);
    db.close();
  });
});

describe("inference base-URL allowlist", () => {
  const budget = { perConversation: 50_000, perDay: 500_000, onExhausted: "stop" } as const;

  test("construction fails when a target is not in trustedBaseUrls", () => {
    const db = freshDb();
    const audit = new AuditLog(db.raw);
    expect(
      () =>
        new InferenceRouter(
          {
            primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" },
            trustedBaseUrls: ["https://api.openai.com"],
            tokenBudget: budget,
          },
          audit.logger,
          db.raw,
        ),
    ).toThrow(/trustedBaseUrls/);
    db.close();
  });

  test("default allowlist accepts the configured target (trailing-slash insensitive)", () => {
    const db = freshDb();
    const audit = new AuditLog(db.raw);
    expect(
      () =>
        new InferenceRouter(
          {
            primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434/" },
            tokenBudget: budget,
          },
          audit.logger,
          db.raw,
        ),
    ).not.toThrow();
    db.close();
  });

  test("fallback target must also be trusted", () => {
    const db = freshDb();
    const audit = new AuditLog(db.raw);
    expect(
      () =>
        new InferenceRouter(
          {
            primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" },
            fallback: { provider: "ollama", model: "m2", baseUrl: "http://evil.example:1234" },
            trustedBaseUrls: ["http://localhost:11434"],
            tokenBudget: budget,
          },
          audit.logger,
          db.raw,
        ),
    ).toThrow(/trustedBaseUrls/);
    db.close();
  });
});
