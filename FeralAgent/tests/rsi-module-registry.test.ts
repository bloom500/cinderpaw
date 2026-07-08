/**
 * L4 Architecture — B1: seam catalog + ModuleManifest loader + ModuleRegistry
 * (spec §1, §2, §12.1–12.2).
 *
 * Contract under test:
 *   AC7  — registry + history survive crash mid-write (temp+rename);
 *          corrupt registry → fail closed to builtins + governance event.
 *   AC11 — forward-compat fields inert but enforced: unknown schemaVersion
 *          → reject; seamApiVersion mismatch → reject at load / auto-demote
 *          at boot; non-empty requires/permissions → reject;
 *          capabilitiesClaimed present but provably unread.
 *   §12.1 — structural: a third catalog row needs ZERO registry/validation
 *          code changes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyChainFile } from "../src/rsi/hash-chain.ts";
import { SEAM_CATALOG, catalogRow, type SeamCatalogRow } from "../src/rsi/seam-catalog.ts";
import {
  ModuleRegistry,
  validateManifest,
  type ModuleManifest,
} from "../src/rsi/module-registry.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "feral-l4-b1-"));
  tmpDirs.push(d);
  return d;
}

const T0 = 1_751_600_000_000;
const RUNTIME = "2026.7.5";

function goodManifest(overrides: Partial<ModuleManifest> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "mod-retrieval-recency-01",
    seam: "retrieval_strategy",
    seamApiVersion: 1,
    compat: { runtime: ">=2026.6.17" },
    requires: [],
    displayName: "Recency-weighted retrieval",
    entry: "module.ts",
    permissions: [],
    capabilitiesClaimed: {},
    limits: { timeoutMs: 2000, maxRssMb: 256 },
    createdAt: T0,
    sourceHash: "a".repeat(64),
    proposedBy: "dream",
    ...overrides,
  };
}

function reg(opts: { catalog?: readonly SeamCatalogRow[]; dir?: string; gov?: string } = {}): {
  registry: ModuleRegistry;
  dir: string;
  gov: string;
} {
  const dir = opts.dir ?? freshDir();
  const gov = opts.gov ?? freshDir();
  const registry = new ModuleRegistry({
    dir,
    governanceDir: gov,
    catalog: opts.catalog,
    now: () => T0,
  });
  return { registry, dir, gov };
}

// ── Manifest validation (§2.1, AC11) ──────────────────────────────────────

describe("validateManifest", () => {
  test("the spec §2.1 example validates", () => {
    const res = validateManifest(goodManifest(), { runtimeVersion: RUNTIME });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.manifest.seam).toBe("retrieval_strategy");
  });

  test("unknown schemaVersion → named reject", () => {
    const res = validateManifest(goodManifest({ schemaVersion: 2 as unknown as 1 }), { runtimeVersion: RUNTIME });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("schemaVersion");
  });

  test("unknown seam → named reject", () => {
    const res = validateManifest(goodManifest({ seam: "tool_selector" }), { runtimeVersion: RUNTIME });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("unknown seam");
  });

  test("seamApiVersion mismatch → named reject, never a call-time crash", () => {
    const res = validateManifest(goodManifest({ seamApiVersion: 2 }), { runtimeVersion: RUNTIME });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("seamApiVersion mismatch");
  });

  test("non-empty requires → reject (reserved, §12.3)", () => {
    const res = validateManifest(goodManifest({ requires: ["mod-x"] }), { runtimeVersion: RUNTIME });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("requires");
  });

  test("non-empty permissions → reject (v1 wall)", () => {
    const res = validateManifest(goodManifest({ permissions: ["net"] }), { runtimeVersion: RUNTIME });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("permissions");
  });

  test("compat.runtime floor above current runtime → reject; at/below → pass", () => {
    const above = validateManifest(goodManifest({ compat: { runtime: ">=2027.1.1" } }), { runtimeVersion: RUNTIME });
    expect(above.ok).toBe(false);
    if (!above.ok) expect(above.reason).toContain("floor not met");
    const at = validateManifest(goodManifest({ compat: { runtime: `>=${RUNTIME}` } }), { runtimeVersion: RUNTIME });
    expect(at.ok).toBe(true);
  });

  test("entry escapes rejected (path separators, .., non-ts)", () => {
    for (const entry of ["../evil.ts", "sub/module.ts", "module.js"]) {
      const res = validateManifest(goodManifest({ entry }), { runtimeVersion: RUNTIME });
      expect(res.ok).toBe(false);
    }
  });

  test("id with path separators rejected (it names a directory)", () => {
    const res = validateManifest(goodManifest({ id: "../mod" }), { runtimeVersion: RUNTIME });
    expect(res.ok).toBe(false);
  });

  test("capabilitiesClaimed is accepted with arbitrary hints (never read)", () => {
    const res = validateManifest(
      goodManifest({ capabilitiesClaimed: { coding: 0.9, "made-up": "sure" } }),
      { runtimeVersion: RUNTIME },
    );
    expect(res.ok).toBe(true);
  });
});

// ── AC11 negative test: capabilitiesClaimed has NO machine consumers ──────

describe("capabilitiesClaimed two-channel rule (§12.4, AC11)", () => {
  test("no source file outside the loader reads capabilitiesClaimed", () => {
    // Grep-level negative test per AC11: the token may appear only in the
    // manifest type/validator (module-registry.ts) and the seam catalog
    // docs. Any routing/promotion consumer would have to import it from
    // somewhere in src/ — scan every TS file under src/ recursively.
    const srcRoot = join(import.meta.dir, "..", "src");
    const offenders: string[] = [];
    const allow = new Set(["module-registry.ts"]);
    const walk = (dir: string) => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, name.name);
        if (name.isDirectory()) walk(p);
        else if (name.name.endsWith(".ts") && readFileSync(p, "utf8").includes("capabilitiesClaimed")) {
          if (!allow.has(name.name)) offenders.push(p);
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});

// ── Registry (§2.3, AC7, §12.2/AC11) ───────────────────────────────────────

describe("ModuleRegistry", () => {
  test("fresh dir → defaults derived from the catalog, all builtin", () => {
    const { registry } = reg();
    const snap = registry.snapshot();
    expect(Object.keys(snap.seams).sort()).toEqual(
      SEAM_CATALOG.map((r) => r.seam).sort(),
    );
    for (const row of SEAM_CATALOG) {
      expect(registry.activeFor(row.seam)).toBe("builtin");
      expect(snap.seams[row.seam]!.seamApiVersion).toBe(row.seamApiVersion);
    }
  });

  test("repoint persists (temp+rename), appends history + governance audit", () => {
    const { registry, dir, gov } = reg();
    registry.addCandidate("planner", "mod-planner-01");
    const res = registry.repoint("planner", "mod-planner-01", "darius", "approved");
    expect(res.ok).toBe(true);
    // Survives reload.
    const again = new ModuleRegistry({ dir, governanceDir: gov, now: () => T0 });
    expect(again.activeFor("planner")).toBe("mod-planner-01");
    const rows = again.historyRows();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ seam: "planner", from: "builtin", to: "mod-planner-01", actor: "darius" });
    // Governance audit mirrored + chain intact.
    const audit = join(gov, "governance_audit.jsonl");
    expect(existsSync(audit)).toBe(true);
    expect(verifyChainFile(audit).ok).toBe(true);
    expect(readFileSync(audit, "utf8")).toContain("module_promoted");
  });

  test("corrupt registry.json → fail closed to builtins + governance event (AC7)", () => {
    const { registry, dir, gov } = reg();
    registry.repoint("planner", "mod-planner-01", "darius", "approved");
    // Crash mid-write shape: the operative file is garbage.
    writeFileSync(join(dir, "registry.json"), "{ half a json", "utf8");
    const recovered = new ModuleRegistry({ dir, governanceDir: gov, now: () => T0 });
    expect(recovered.activeFor("planner")).toBe("builtin");
    expect(recovered.activeFor("retrieval_strategy")).toBe("builtin");
    expect(readFileSync(join(gov, "governance_audit.jsonl"), "utf8")).toContain("registry_fail_closed");
    // And it re-persisted a valid file.
    expect(JSON.parse(readFileSync(join(dir, "registry.json"), "utf8")).version).toBe(1);
  });

  test("unknown registry shape → fail closed to builtins", () => {
    const { dir, gov } = reg();
    writeFileSync(join(dir, "registry.json"), JSON.stringify({ version: 99 }), "utf8");
    const recovered = new ModuleRegistry({ dir, governanceDir: gov, now: () => T0 });
    expect(recovered.activeFor("planner")).toBe("builtin");
  });

  test("seam API bump auto-demotes the active module at boot (§12.2, AC11)", () => {
    const { registry, dir, gov } = reg();
    registry.repoint("retrieval_strategy", "mod-old-01", "darius", "approved");
    // The runtime ships a breaking seam-interface change: catalog v2.
    const bumped: SeamCatalogRow[] = SEAM_CATALOG.map((r) =>
      r.seam === "retrieval_strategy" ? { ...r, seamApiVersion: 2 } : r,
    );
    const rebooted = new ModuleRegistry({ dir, governanceDir: gov, catalog: bumped, now: () => T0 });
    expect(rebooted.activeFor("retrieval_strategy")).toBe("builtin");
    expect(rebooted.snapshot().seams["retrieval_strategy"]!.seamApiVersion).toBe(2);
    const rows = rebooted.historyRows();
    expect(rows.at(-1)?.reason).toContain("seam API bump");
    expect(readFileSync(join(gov, "governance_audit.jsonl"), "utf8")).toContain("module_incompatible");
  });

  test("candidates add/remove round-trip and survive reload", () => {
    const { registry, dir, gov } = reg();
    registry.addCandidate("retrieval_strategy", "mod-a");
    registry.addCandidate("retrieval_strategy", "mod-a"); // idempotent
    registry.addCandidate("retrieval_strategy", "mod-b");
    expect(registry.candidatesFor("retrieval_strategy")).toEqual(["mod-a", "mod-b"]);
    registry.removeCandidate("retrieval_strategy", "mod-a");
    const again = new ModuleRegistry({ dir, governanceDir: gov, now: () => T0 });
    expect(again.candidatesFor("retrieval_strategy")).toEqual(["mod-b"]);
  });
});

// ── §12.1 structural test: seam #3 costs zero code changes ────────────────

describe("seam catalog is data (§12.1)", () => {
  const THIRD: SeamCatalogRow = {
    seam: "tool_selector",
    seamApiVersion: 1,
    builtinId: "builtin:tool_selector",
    resolutionPoints: ["test fixture"],
    requestSchema: { type: "object" },
    responseSchema: { type: "object" },
  };

  test("registry + validation accept a third catalog row with no code changes", () => {
    const catalog = [...SEAM_CATALOG, THIRD];
    const { registry } = reg({ catalog });
    // Registry grew the seam from data alone.
    expect(registry.activeFor("tool_selector")).toBe("builtin");
    // Validation accepts a manifest targeting it.
    const res = validateManifest(goodManifest({ seam: "tool_selector", id: "mod-tools-01" }), {
      catalog,
      runtimeVersion: RUNTIME,
    });
    expect(res.ok).toBe(true);
    // And an existing registry picks the new seam up at reboot.
    expect(catalogRow("tool_selector", catalog)?.builtinId).toBe("builtin:tool_selector");
  });

  test("adding the row to a PRE-EXISTING registry backfills it at boot", () => {
    const { dir, gov } = reg(); // persisted with 2 seams
    const catalog = [...SEAM_CATALOG, THIRD];
    const upgraded = new ModuleRegistry({ dir, governanceDir: gov, catalog, now: () => T0 });
    expect(upgraded.activeFor("tool_selector")).toBe("builtin");
    expect(Object.keys(upgraded.snapshot().seams)).toContain("tool_selector");
  });
});
