/**
 * Tool observation telemetry — adapted from ECC (affaan-m/ECC).
 *
 * Every tool call records a structured observation to a JSONL file
 * (data/tool-observations.jsonl). The file is append-only and human-readable.
 * The ToolRegistry calls `append()` after each invocation; the `tool_health`
 * builtin tool calls `buildHealthReport()` to surface aggregated stats.
 *
 * Design choices:
 *   - JSONL on disk (not SQLite) — matches ECC's pattern, easy to inspect/grep
 *   - Append-only — observations are never mutated or deleted
 *   - Health report aggregates by tool: success rate, failure count, recent errors
 *   - "failing" threshold: ≥2 failures and success rate <0.6
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

// ── Schema ────────────────────────────────────────────────────────────────────

export const SCHEMA_VERSION = "cinderpaw.tool-observation.v1" as const;

/** What the same records were stamped with before the rename. The log is
  * append-only and lives on the user's disk, so every line written until now
  * carries this and would become invisible to `tool-health` if the reader
  * only accepted the new one — the tool would report no history on a machine
  * that has months of it. */
export const LEGACY_SCHEMA_VERSION = "feral.tool-observation.v1" as const;

export interface ToolObservation {
  schemaVersion: typeof SCHEMA_VERSION | typeof LEGACY_SCHEMA_VERSION;
  observationId: string;
  timestamp: string;        // ISO 8601
  sessionId: string;
  tool: string;
  success: boolean;
  durationMs: number;
  error: string | null;
  argsKeys: string[];       // argument names only (values not stored for privacy)
}

export type HealthStatus = "healthy" | "watch" | "failing";

export interface ToolHealth {
  tool: string;
  totalRuns: number;
  successes: number;
  failures: number;
  successRate: number;      // 0.000–1.000
  status: HealthStatus;
  avgDurationMs: number;
  recentErrors: Array<{ error: string; count: number }>;
}

export interface HealthReport {
  generatedAt: string;
  totalObservations: number;
  tools: ToolHealth[];
}

// ── Append ────────────────────────────────────────────────────────────────────

export class ToolObservationLog {
  readonly #path: string;

  constructor(dataDir: string) {
    this.#path = `${dataDir}/tool-observations.jsonl`;
  }

  append(obs: Omit<ToolObservation, "schemaVersion" | "observationId" | "timestamp">): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const record: ToolObservation = {
        schemaVersion: SCHEMA_VERSION,
        observationId: `obs-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        ...obs,
      };
      appendFileSync(this.#path, JSON.stringify(record) + "\n", "utf8");
    } catch {
      // Telemetry must never crash the agent.
    }
  }

  // ── Health aggregation ──────────────────────────────────────────────────────

  buildHealthReport(): HealthReport {
    const records = this.#readAll();
    const byTool = new Map<string, ToolObservation[]>();

    for (const r of records) {
      if (!byTool.has(r.tool)) byTool.set(r.tool, []);
      byTool.get(r.tool)!.push(r);
    }

    const tools: ToolHealth[] = [];

    for (const [tool, obs] of byTool) {
      const successes = obs.filter((o) => o.success).length;
      const failures = obs.length - successes;
      const successRate = obs.length > 0
        ? Math.round((successes / obs.length) * 1000) / 1000
        : 0;
      const avgDurationMs = obs.length > 0
        ? Math.round(obs.reduce((s, o) => s + o.durationMs, 0) / obs.length)
        : 0;

      // Count recurring errors
      const errorCounts = new Map<string, number>();
      for (const o of obs) {
        if (!o.success && o.error) {
          errorCounts.set(o.error, (errorCounts.get(o.error) ?? 0) + 1);
        }
      }
      const recentErrors = [...errorCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([error, count]) => ({ error, count }));

      const status: HealthStatus =
        failures >= 2 && successRate < 0.6 ? "failing" :
        failures >= 1 && successRate < 0.8 ? "watch"   :
        "healthy";

      tools.push({ tool, totalRuns: obs.length, successes, failures, successRate, avgDurationMs, status, recentErrors });
    }

    // Sort: failing first, then by name
    tools.sort((a, b) => {
      const rank = { failing: 0, watch: 1, healthy: 2 };
      const dr = rank[a.status] - rank[b.status];
      return dr !== 0 ? dr : a.tool.localeCompare(b.tool);
    });

    return {
      generatedAt: new Date().toISOString(),
      totalObservations: records.length,
      tools,
    };
  }

  /** Delete observations older than `days` days to keep the file bounded. */
  pruneOlderThan(days: number): number {
    const cutoff = Date.now() - days * 86_400_000;
    const records = this.#readAll().filter(
      (r) => new Date(r.timestamp).getTime() >= cutoff,
    );
    try {
      const content = records.map((r) => JSON.stringify(r)).join("\n");
      require("node:fs").writeFileSync(this.#path, content ? content + "\n" : "", "utf8");
    } catch {
      // Non-fatal.
    }
    return records.length;
  }

  #readAll(): ToolObservation[] {
    if (!existsSync(this.#path)) return [];
    try {
      return readFileSync(this.#path, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line) as ToolObservation; } catch { return null; }
        })
        .filter(
          (r): r is ToolObservation =>
            r?.schemaVersion === SCHEMA_VERSION || r?.schemaVersion === LEGACY_SCHEMA_VERSION,
        );
    } catch {
      return [];
    }
  }
}
