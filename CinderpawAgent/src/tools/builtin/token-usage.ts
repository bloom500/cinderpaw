/**
 * token_usage — the glass over the meter.
 *
 * The accounting has existed for a while: `cost-report.ts` splits what we sent
 * by category and reports what the provider charged, deliberately keeping the
 * two accounts separate rather than multiplying them into one plausible lie.
 * `InferenceRouter.costReport()` renders it. `AgentLoop.costReport()` forwards
 * it. And nothing, anywhere in the product, called any of them — the comment
 * on the router calls itself "the glass over the dial", but the glass was
 * installed facing a wall.
 *
 * So a person using Cinderpaw had no way to answer "how much am I spending,
 * and is the prompt cache actually helping?" — and neither did the agent about
 * itself. Today's measurement of the fixed floor (10,704 tokens re-sent on
 * every completion) came from reading the sidecar's stderr, which is not a
 * thing a user can do.
 *
 * A TOOL rather than a slash command, deliberately: a command lives on one
 * surface, and this is a question people ask from chat, the CLI, and a
 * connector alike. Registered always — the report is read-only, costs one
 * SQLite query, and an agent that cannot see its own bill is the thing being
 * fixed.
 */

import type { Tool, ToolManifest } from "../../types.ts";

export interface TokenUsageDeps {
  /** Renders the report. `AgentLoop.costReport()` — injected so this file
   *  neither imports the loop nor holds a database handle. */
  costReport: () => string;
}

export function createTokenUsageTool(deps: TokenUsageDeps): Tool {
  const manifest: ToolManifest = {
    name: "token_usage",
    description:
      "Where your tokens went: what was sent by category (system prompt, tool " +
      "schemas, history, tool output) and what the provider actually charged, " +
      "including how much was served from the prompt cache. Use it when asked " +
      "about cost, spend, token usage, or why a conversation feels expensive.",
    permissions: [],
    networkAccess: false,
  };
  return {
    manifest,
    parameters: {},
    async execute() {
      let content: string;
      try {
        content = deps.costReport();
      } catch (err) {
        // Accounting that can cost a user their turn is worse than no
        // accounting — the same rule the router's own report is written to.
        return {
          ok: false,
          content: `Could not read the usage report: ${err instanceof Error ? err.message : String(err)}`,
          error: "report_failed",
        };
      }
      return { ok: true, content };
    },
  };
}
