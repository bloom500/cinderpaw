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
import type { InferenceRouter } from "../../sandbox/inference-router.ts";
import { ResearchLoop } from "../../research/research-loop.ts";

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
  };

  return {
    manifest,
    parameters: {
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
      const question = args.question;
      if (typeof question !== "string" || !question.trim()) {
        return {
          ok: false,
          content: "deep_research requires a non-empty 'question' string.",
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
        );
        const result = await loop.run(question.trim(), maxIter);

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
        return {
          ok: false,
          content: `Research failed: ${err instanceof Error ? err.message : String(err)}`,
          error: "research_error",
        };
      }
    },
  };
}
