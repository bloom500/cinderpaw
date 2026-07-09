/**
 * deep_research — single-call DeepResearch orchestrator.
 *
 * Wraps the ResearchLoop in a tool interface. The InferenceRouter is injected
 * at registration time (via the factory) so the loop can make LLM calls for
 * planning, URL selection, extraction, and synthesis — all within one tool
 * invocation, transparently to the outer agent loop.
 *
 * Allowed domains (declared in manifest, enforced by EgressProxy):
 *   s.jina.ai — Jina Search (web search, returns structured results)
 *   r.jina.ai — Jina Reader (extracts clean markdown from any URL)
 *
 * Optional env vars:
 *   FERAL_JINA_API_KEY — Bearer token for higher Jina rate limits
 */

import type { Tool, ToolManifest } from "../../types.ts";
import type { InferenceRouter } from "../../egress/inference-router.ts";
import { ResearchLoop } from "../../research/research-loop.ts";

/**
 * Pull the research question out of the args, accepting aliases in priority
 * order. Keys are normalized (lowercased, non-alphanumerics stripped) before
 * matching because local models sometimes emit corrupted keys like `query"`.
 * Returns the trimmed question, or null if no usable string was found.
 */
const QUESTION_ALIASES = ["question", "query", "topic", "q", "prompt"];

export function extractQuestion(args: Record<string, unknown>): string | null {
  const normalized = new Map<string, string>();
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string" || !value.trim()) continue;
    const norm = key.toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (!normalized.has(norm)) normalized.set(norm, value.trim());
  }
  for (const alias of QUESTION_ALIASES) {
    const hit = normalized.get(alias);
    if (hit) return hit;
  }
  return null;
}

export function createDeepResearchTool(
  router: InferenceRouter,
  jinaApiKey?: string,
): Tool {
  const manifest: ToolManifest = {
    name: "deep_research",
    description:
      "Conduct multi-step web research on any topic. Autonomously searches the web, " +
      "reads the most relevant pages, extracts key findings, and synthesizes a " +
      "comprehensive markdown report with inline citations and a sources list. " +
      "Use this for complex questions that require up-to-date information from multiple sources.",
    permissions: ["network:outbound"],
    networkAccess: true,
    allowedDomains: ["s.jina.ai", "r.jina.ai"],
    // Feral-WIP #2: if Jina search fails (network / quota), fall back
    // to read_webpage which can be invoked with a URL. The agent may
    // also chain web_search -> deep_research via web_search's own
    // fallback, so the chain is web_search -> deep_research -> read_webpage.
    fallback: ["read_webpage"],
  };

  return {
    manifest,
    parameters: {
      // Canonical parameter is `question`; execute() also accepts the
      // aliases query/topic/q/prompt because local models frequently use
      // them despite the declared schema (7/9 bad_args in observations).
      question: {
        type: "string",
        description:
          "The research question or topic to investigate. Be specific for better results.",
        required: true,
      },
      max_iterations: {
        type: "number",
        description:
          "How many search-read-extract cycles to run (default: 4, max: 8). " +
          "More iterations = more thorough but slower.",
        required: false,
      },
    },
    async execute(args, ctx) {
      const question = extractQuestion(args);
      if (question === null) {
        return {
          ok: false,
          content:
            "deep_research requires a non-empty 'question' string " +
            "(aliases accepted: query, topic, q, prompt).",
          error: "bad_args",
        };
      }

      const maxIter = Math.min(
        typeof args.max_iterations === "number"
          ? Math.floor(args.max_iterations)
          : 4,
        8,
      );

      try {
        const loop = new ResearchLoop(
          router,
          ctx.fetch,
          ctx.sessionId,
          jinaApiKey,
          ctx.signal,
          ctx.progress,
        );
        const result = await loop.run(question.trim(), maxIter);
        if (result.stopped) {
          return {
            ok: false,
            content: "Research stopped before completion.",
            error: "cancelled",
            data: {
              stopped: true,
              report: result.report,
              sources: result.sources,
              iterations: result.iterations,
            },
          };
        }

        return {
          ok: true,
          content: result.report,
          data: {
            sources: result.sources,
            iterations: result.iterations,
            sourcesCount: result.sources.length,
          },
        };
      } catch (err) {
        if (err instanceof Error && err.name === "ResearchStoppedError") {
          return {
            ok: false,
            content: "Research stopped before completion.",
            error: "cancelled",
          };
        }
        return {
          ok: false,
          content: `Research failed: ${err instanceof Error ? err.message : String(err)}`,
          error: "research_error",
        };
      }
    },
  };
}
