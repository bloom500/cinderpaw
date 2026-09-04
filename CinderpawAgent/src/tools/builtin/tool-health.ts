/**
 * tool_health — agent-callable ECC-style health report.
 *
 * Reads the JSONL observation log and returns a Markdown report showing
 * success rates, average latency, and recurring errors for every tool the
 * agent has invoked. Useful for self-diagnosis: the agent can call this to
 * understand which tools are unreliable before deciding whether to retry.
 *
 * No network access; reads only the local observation log.
 */

import type { Tool, ToolManifest } from "../../types.ts";
import type { ToolObservationLog } from "../../telemetry/tool-observations.ts";

export function createToolHealthTool(observations: ToolObservationLog): Tool {
  const manifest: ToolManifest = {
    name: "tool_health",
    description:
      "Show a health report for all tools: success rates, average latency, " +
      "and any recurring errors. Use this to understand which tools are " +
      "unreliable before deciding to retry or switch approach.",
    permissions: [],
    networkAccess: false,
  };

  return {
    manifest,
    parameters: {
      since_days: {
        type: "number",
        description: "Only include observations from the last N days (default: 30).",
        required: false,
      },
    },
    async execute(_args) {
      const report = observations.buildHealthReport();

      if (report.tools.length === 0) {
        return {
          ok: true,
          content: "No tool observations recorded yet. Tool health data builds up as tools are used.",
          data: report,
        };
      }

      const lines: string[] = [
        `## Tool Health Report`,
        `_${report.totalObservations} observations · generated ${report.generatedAt.slice(0, 19).replace("T", " ")} UTC_`,
        "",
        "| Tool | Runs | Success | Avg ms | Status |",
        "|------|------|---------|--------|--------|",
      ];

      for (const t of report.tools) {
        const pct = `${Math.round(t.successRate * 100)}%`;
        const statusEmoji =
          t.status === "failing" ? "🔴 failing" :
          t.status === "watch"   ? "🟡 watch"   :
                                   "🟢 healthy";
        lines.push(
          `| \`${t.tool}\` | ${t.totalRuns} | ${pct} (${t.successes}/${t.totalRuns}) | ${t.avgDurationMs} | ${statusEmoji} |`,
        );
      }

      // Surface failing tools with error details
      const failing = report.tools.filter((t) => t.status !== "healthy");
      if (failing.length > 0) {
        lines.push("", "### Issues");
        for (const t of failing) {
          lines.push(`**\`${t.tool}\`** — ${t.failures} failure(s), ${Math.round(t.successRate * 100)}% success rate`);
          for (const e of t.recentErrors) {
            lines.push(`  - \`${e.error}\` (×${e.count})`);
          }
        }
      }

      return {
        ok: true,
        content: lines.join("\n"),
        data: report,
      };
    },
  };
}
