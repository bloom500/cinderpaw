/**
 * L4 Architecture Evolution — ModuleManifest loader + ModuleRegistry
 * (spec §2, §12.2). B1 of Phase B.
 *
 * The manifest shape is FROZEN in v1 including its forward-compat fields
 * (`requires`, `capabilitiesClaimed`, `compat`) — they are validated but
 * carry no behavior yet (§12). Validation is fail-loud with named reasons:
 * a module is refused at load, never crashed at call time.
 *
 * The registry maps seam → active implementation ("builtin" or a promoted
 * module id). Rollback is always "point the seam back at the builtin" —
 * O(1), no rebuild. Corrupt registry fails CLOSED to builtins with a
 * governance event (AC7). A seam-API major bump auto-demotes stale modules
 * at boot with state `incompatible` (§12.2, AC11) — modules age out of the
 * seam, they never crash it.
 *
 * Everything here is written against the seam CATALOG, not named seams
 * (§12.1): adding a seam must require zero changes in this file.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendGovernanceAudit } from "./governance-audit.ts";
import { defaultGovernanceDir } from "./governance.ts";
import { paths } from "./instance-paths.ts";
import { catalogRow, SEAM_CATALOG, type SeamCatalogRow } from "./seam-catalog.ts";

// ── Manifest (spec §2.1) ───────────────────────────────────────────────────

export interface ModuleLimits {
  timeoutMs: number;
  maxRssMb: number;
}

export interface ModuleManifest {
  schemaVersion: 1;
  id: string;
  seam: string;
  seamApiVersion: number;
  compat: { runtime: string };
  /** v1: MUST be [] — reserved for module dependency ids (§12.3). */
  requires: string[];
  displayName: string;
  /** Single file, relative, no escapes. */
  entry: string;
  /** v1: MUST be [] — no fs, no net, no env. */
  permissions: string[];
  /** Proposer HINTS for humans on the approval card. NEVER machine-read
   *  (§12.4 two-channel rule; negative test enforces zero consumers). */
  capabilitiesClaimed: Record<string, unknown>;
  limits: ModuleLimits;
  createdAt: number;
  sourceHash: string;
  proposedBy: "dream" | "operator";
}

export type ManifestResult =
  | { ok: true; manifest: ModuleManifest }
  | { ok: false; reason: string };

/** Compare two dotted numeric versions (CalVer `2026.7.5` or the unpadded
 *  semver the repo uses — see docs/RELEASING.md). Returns a<b:-1 a=b:0 a>b:1. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return Number.NaN as unknown as number;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

const VERSION_RE = /^\d+(\.\d+)*$/;

/** Validate a raw manifest per §2.1. Fail-loud, named reasons, never throws. */
export function validateManifest(
  raw: unknown,
  opts: { catalog?: readonly SeamCatalogRow[]; runtimeVersion: string },
): ManifestResult {
  const bad = (reason: string): ManifestResult => ({ ok: false, reason });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("manifest is not an object");
  const m = raw as Record<string, unknown>;

  if (m.schemaVersion !== 1) return bad(`unknown schemaVersion: ${JSON.stringify(m.schemaVersion)}`);

  if (typeof m.id !== "string" || m.id.length === 0) return bad("id: missing or empty");
  if (/[\\/]|\.\./.test(m.id)) return bad(`id must not contain path separators or '..': ${JSON.stringify(m.id)}`);

  const catalog = opts.catalog ?? SEAM_CATALOG;
  if (typeof m.seam !== "string") return bad("seam: missing");
  const row = catalogRow(m.seam, catalog);
  if (!row) return bad(`unknown seam: ${JSON.stringify(m.seam)} (not in the seam catalog)`);
  if (m.seamApiVersion !== row.seamApiVersion) {
    return bad(
      `seamApiVersion mismatch: manifest targets ${JSON.stringify(m.seamApiVersion)}, catalog is at ${row.seamApiVersion} for ${row.seam}`,
    );
  }

  const compat = m.compat as Record<string, unknown> | undefined;
  if (!compat || typeof compat.runtime !== "string") return bad("compat.runtime: missing");
  const floorMatch = /^>=(.+)$/.exec(compat.runtime.trim());
  if (!floorMatch || !VERSION_RE.test(floorMatch[1]!)) {
    return bad(`compat.runtime must be ">=X.Y.Z": ${JSON.stringify(compat.runtime)}`);
  }
  if (compareVersions(opts.runtimeVersion, floorMatch[1]!) < 0) {
    return bad(`compat.runtime floor not met: needs ${compat.runtime}, runtime is ${opts.runtimeVersion}`);
  }

  if (!Array.isArray(m.requires) || m.requires.length > 0) {
    return bad("requires must be [] in v1 (module dependencies are reserved, §12.3)");
  }
  if (!Array.isArray(m.permissions) || m.permissions.length > 0) {
    return bad("permissions must be [] in v1 (no fs, no net, no env)");
  }

  if (typeof m.displayName !== "string" || m.displayName.length === 0) return bad("displayName: missing");

  if (typeof m.entry !== "string" || m.entry.length === 0) return bad("entry: missing");
  if (/[\\/]|\.\./.test(m.entry)) return bad(`entry must be a single relative file with no escapes: ${JSON.stringify(m.entry)}`);
  if (!m.entry.endsWith(".ts")) return bad(`entry must be a .ts file: ${JSON.stringify(m.entry)}`);

  // Accepted but never read by any routing/promotion path (§12.4).
  if (!m.capabilitiesClaimed || typeof m.capabilitiesClaimed !== "object" || Array.isArray(m.capabilitiesClaimed)) {
    return bad("capabilitiesClaimed must be an object (may be empty)");
  }

  const limits = m.limits as Record<string, unknown> | undefined;
  if (
    !limits ||
    typeof limits.timeoutMs !== "number" || limits.timeoutMs <= 0 ||
    typeof limits.maxRssMb !== "number" || limits.maxRssMb <= 0
  ) {
    return bad("limits: timeoutMs and maxRssMb must be positive numbers");
  }

  if (typeof m.createdAt !== "number") return bad("createdAt: missing");
  if (typeof m.sourceHash !== "string" || m.sourceHash.length === 0) return bad("sourceHash: missing");
  if (m.proposedBy !== "dream" && m.proposedBy !== "operator") {
    return bad(`proposedBy must be "dream" | "operator": ${JSON.stringify(m.proposedBy)}`);
  }

  return { ok: true, manifest: m as unknown as ModuleManifest };
}

/** Read + validate `modules/<id>/manifest.json`. */
export function loadManifest(
  moduleDir: string,
  opts: { catalog?: readonly SeamCatalogRow[]; runtimeVersion: string },
): ManifestResult {
  const p = join(moduleDir, "manifest.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    return { ok: false, reason: `manifest unreadable: ${String(err)}` };
  }
  return validateManifest(raw, opts);
}

// ── Registry (spec §2.3) ───────────────────────────────────────────────────

export interface SeamEntry {
  seamApiVersion: number;
  /** "builtin" or a promoted module id. */
  active: string;
  candidates: string[];
}

export interface RegistryFile {
  version: 1;
  seams: Record<string, SeamEntry>;
}

export interface RegistryHistoryRow {
  timestamp: number;
  seam: string;
  from: string;
  to: string;
  actor: string;
  reason: string;
  /** Present on lifecycle STATE rows (spec §3: every transition appends
   *  here). Absent on active-repoint rows — `from`/`to` are then impls. */
  moduleId?: string;
}

export function defaultModulesDir(): string {
  return paths().modules;
}

export interface ModuleRegistryOpts {
  /** Modules dir override (tests). Default: `paths().modules`. */
  dir?: string;
  catalog?: readonly SeamCatalogRow[];
  /** Governance dir for audit events. Default: `defaultGovernanceDir()`. */
  governanceDir?: string;
  now?: () => number;
  log?: (msg: string) => void;
}

/** Default registry derived from the catalog — every seam starts at builtin. */
function defaultRegistry(catalog: readonly SeamCatalogRow[]): RegistryFile {
  const seams: Record<string, SeamEntry> = {};
  for (const row of catalog) {
    seams[row.seam] = { seamApiVersion: row.seamApiVersion, active: "builtin", candidates: [] };
  }
  return { version: 1, seams };
}

export class ModuleRegistry {
  private readonly dir: string;
  private readonly catalog: readonly SeamCatalogRow[];
  private readonly governanceDir: string;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly registryPath: string;
  private readonly historyPath: string;
  private registry: RegistryFile;

  constructor(opts: ModuleRegistryOpts = {}) {
    this.dir = opts.dir ?? defaultModulesDir();
    this.catalog = opts.catalog ?? SEAM_CATALOG;
    this.governanceDir = opts.governanceDir ?? defaultGovernanceDir();
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.registryPath = join(this.dir, "registry.json");
    this.historyPath = join(this.dir, "registry_history.jsonl");
    mkdirSync(this.dir, { recursive: true });
    this.registry = this.load();
    this.reconcileWithCatalog();
  }

  // ── Reads ────────────────────────────────────────────────────────────

  snapshot(): RegistryFile {
    return structuredClone(this.registry);
  }

  /** The active implementation for a seam: "builtin" or a module id.
   *  Unknown seam → "builtin" (fail-closed). */
  activeFor(seam: string): string {
    return this.registry.seams[seam]?.active ?? "builtin";
  }

  candidatesFor(seam: string): string[] {
    return [...(this.registry.seams[seam]?.candidates ?? [])];
  }

  historyRows(limit = 200): RegistryHistoryRow[] {
    if (!existsSync(this.historyPath)) return [];
    const lines = readFileSync(this.historyPath, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    const rows: RegistryHistoryRow[] = [];
    for (const line of lines) {
      try {
        rows.push(JSON.parse(line) as RegistryHistoryRow);
      } catch {
        // Malformed history rows are skipped, never fatal — history is
        // forensics, the registry file is the operative state.
      }
    }
    return rows.slice(-limit);
  }

  // ── Mutations ────────────────────────────────────────────────────────

  addCandidate(seam: string, moduleId: string): { ok: boolean; reason?: string } {
    const entry = this.registry.seams[seam];
    if (!entry) return { ok: false, reason: `unknown seam: ${seam}` };
    if (!entry.candidates.includes(moduleId)) {
      entry.candidates.push(moduleId);
      this.persist();
    }
    return { ok: true };
  }

  removeCandidate(seam: string, moduleId: string): void {
    const entry = this.registry.seams[seam];
    if (!entry) return;
    const i = entry.candidates.indexOf(moduleId);
    if (i >= 0) {
      entry.candidates.splice(i, 1);
      this.persist();
    }
  }

  /** Re-point a seam. The ONLY write path for `active` (promotion B5,
   *  demote/quarantine B3, freeze §8.3 all route through here). Appends a
   *  history row and mirrors a governance audit event. */
  repoint(seam: string, to: string, actor: string, reason: string): { ok: boolean; reason?: string } {
    const entry = this.registry.seams[seam];
    if (!entry) return { ok: false, reason: `unknown seam: ${seam}` };
    const from = entry.active;
    if (from === to) return { ok: true };
    entry.active = to;
    this.persist();
    this.appendHistory({ timestamp: this.now(), seam, from, to, actor, reason });
    appendGovernanceAudit(this.governanceDir, {
      timestamp: this.now(),
      source: "l4",
      event: to === "builtin" ? "module_demoted" : "module_promoted",
      refId: to === "builtin" ? from : to,
      summary: `${seam}: ${from} → ${to} (${reason})`,
    });
    return { ok: true };
  }

  /** Append a lifecycle state-transition row (spec §3: every transition
   *  lands in registry_history.jsonl). Forensics only — the envelope owns
   *  the operative state; this is the ordered timeline beside repoints. */
  recordStateTransition(
    seam: string,
    moduleId: string,
    from: string,
    to: string,
    actor: string,
    reason: string,
  ): void {
    this.appendHistory({ timestamp: this.now(), seam, from, to, actor, reason, moduleId });
  }

  // ── Internals ────────────────────────────────────────────────────────

  private load(): RegistryFile {
    if (!existsSync(this.registryPath)) return defaultRegistry(this.catalog);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.registryPath, "utf8"));
    } catch (err) {
      // Corrupt registry → fail CLOSED to builtins + governance event (AC7).
      this.log(`modules: registry.json unreadable (${String(err)}) — failing closed to builtins`);
      appendGovernanceAudit(this.governanceDir, {
        timestamp: this.now(),
        source: "l4",
        event: "registry_fail_closed",
        refId: "registry",
        summary: `registry.json unreadable — all seams reset to builtin (${String(err).slice(0, 120)})`,
      });
      const reg = defaultRegistry(this.catalog);
      this.registry = reg;
      this.persist();
      return reg;
    }
    const parsed = raw as RegistryFile;
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1 || typeof parsed.seams !== "object") {
      this.log("modules: registry.json has an unknown shape — failing closed to builtins");
      appendGovernanceAudit(this.governanceDir, {
        timestamp: this.now(),
        source: "l4",
        event: "registry_fail_closed",
        refId: "registry",
        summary: "registry.json unknown shape — all seams reset to builtin",
      });
      const reg = defaultRegistry(this.catalog);
      this.registry = reg;
      this.persist();
      return reg;
    }
    return parsed;
  }

  /** Boot reconciliation with the catalog (§12.2, AC11):
   *  - seams missing from the registry are added at builtin;
   *  - a seam whose catalog `seamApiVersion` moved past the registry's
   *    auto-demotes any active module to builtin (state `incompatible` —
   *    recoverable via re-evaluation) and adopts the new version. */
  private reconcileWithCatalog(): void {
    let dirty = false;
    for (const row of this.catalog) {
      const entry = this.registry.seams[row.seam];
      if (!entry) {
        this.registry.seams[row.seam] = {
          seamApiVersion: row.seamApiVersion,
          active: "builtin",
          candidates: [],
        };
        dirty = true;
        continue;
      }
      if (entry.seamApiVersion !== row.seamApiVersion) {
        const stale = entry.active;
        entry.seamApiVersion = row.seamApiVersion;
        if (stale !== "builtin") {
          entry.active = "builtin";
          this.appendHistory({
            timestamp: this.now(),
            seam: row.seam,
            from: stale,
            to: "builtin",
            actor: "system",
            reason: `seam API bump → ${row.seamApiVersion}: ${stale} incompatible (recoverable via re-evaluation)`,
          });
          appendGovernanceAudit(this.governanceDir, {
            timestamp: this.now(),
            source: "l4",
            event: "module_incompatible",
            refId: stale,
            summary: `${row.seam}: auto-demoted at boot — module targets seam API ${entry.seamApiVersion}, catalog moved to ${row.seamApiVersion}`,
          });
          this.log(`modules: ${stale} auto-demoted (seam ${row.seam} API → v${row.seamApiVersion})`);
        }
        dirty = true;
      }
    }
    if (dirty) this.persist();
  }

  /** Temp-file+rename, same crash-safe discipline as L6's persist(). */
  private persist(): void {
    const tmp = `${this.registryPath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.registry, null, 2), "utf8");
    renameSync(tmp, this.registryPath);
  }

  private appendHistory(row: RegistryHistoryRow): void {
    appendFileSync(this.historyPath, `${JSON.stringify(row)}\n`, "utf8");
  }
}
