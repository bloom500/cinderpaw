/**
 * Instance paths — the single source of truth for per-tenant storage locations.
 *
 * Why this exists:
 *   Today, every Feral RSI artifact lives under `~/.feral/rsi/`. The
 *   per-instance divergence model (BRSI §3.3) calls for a split into:
 *
 *     ~/.feral/shared/                    — Tier 0 specs, scoring weights,
 *                                           immutable core (agent cannot write)
 *     ~/.feral/instances/<tenant_id>/    — per-tenant genomes, adapters,
 *                                           demos, eval suites, journal, audit
 *
 *   The split is a real refactor (Rust side `paths.rs` + TS side this
 *   file + the journal / champion / envelope writers). Until it lands,
 *   every tenant gets the SAME paths (the v1 shared layout).
 *
 *   The contract this module establishes:
 *     1. Every TS caller goes through `paths(tenant)` — never hardcodes
 *        `~/.feral/rsi/`.
 *     2. `assertTenant(tenant)` validates a tenant id before any path
 *        computation, defending against `../` and path-separator escapes.
 *     3. The post-split layout is documented here, not invented elsewhere.
 *
 *   When the split lands, only this file changes.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** Default tenant id when none is supplied. Single-user installs never
 *  pass anything else. Multi-user installs (post-split) get a UUID. */
export const DEFAULT_TENANT = "default";

/** All the paths a tenant's RSI state occupies. */
export interface InstancePaths {
  /** Root for this tenant's RSI state. v1: `~/.feral/rsi/`.
   *  v2 (post-split): `~/.feral/instances/<tenant>/rsi/`. */
  root: string;
  /** Hash-chained NDJSON audit log for SandboxBounds mutations. */
  auditLog: string;
  /** The persisted champion record (live-agent-facing best config). */
  champion: string;
  /** Journal directory; per-day JSONL files inside. */
  journalDir: string;
  /** Taste miner state (PBT vectors across cycles). */
  tasteState: string;
  /** Envelope storage for non-code artifacts (LoRA / demo / eval_task).
   *  Storage write-path is TODO; the directory is reserved. */
  envelopes: string;
  /** Git substrate path (libgit2 backs the ratchet). Shared across
   *  tenants today; per-instance split would require forking the
   *  substrate per tenant, which is its own refactor. */
  gitSubstrate: string;
}

/** Compute the paths for a given tenant. v1 returns the shared layout
 *  (every tenant gets the same paths). v2 (post-split) will return
 *  distinct per-tenant paths. */
export function paths(tenant: string = DEFAULT_TENANT): InstancePaths {
  assertTenant(tenant);
  // v1: shared root. v2 would replace this with a per-tenant subdir.
  const root = join(homedir(), ".feral", "rsi");
  return {
    root,
    auditLog: join(root, "sandbox_bounds.audit.log"),
    champion: join(root, "champion.json"),
    journalDir: join(root, "journal"),
    tasteState: join(root, "pbt_state.json"),
    envelopes: join(root, "envelopes"),
    gitSubstrate: join(root, "substrate.git"),
  };
}

/** Validate a tenant id. Defends against `../` escapes and path
 *  separators before any path computation runs. Cheap; call once
 *  per tenant resolution. */
export function assertTenant(tenant: string): void {
  if (typeof tenant !== "string" || tenant.length === 0) {
    throw new Error(`invalid tenant id: must be a non-empty string`);
  }
  // Reject path separators and parent-directory escapes.
  if (tenant.includes("..") || tenant.includes("/") || tenant.includes("\\")) {
    throw new Error(`tenant id must not contain path separators: ${JSON.stringify(tenant)}`);
  }
  // Reject shell metacharacters that could become a problem in
  // shell-quoted paths (paranoid; future-proof).
  const forbidden = /[\0\n\r;|&`$<>]/;
  if (forbidden.test(tenant)) {
    throw new Error(`tenant id contains forbidden characters: ${JSON.stringify(tenant)}`);
  }
}