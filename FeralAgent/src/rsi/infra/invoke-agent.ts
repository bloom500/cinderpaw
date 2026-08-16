/**
 * Faza 1 — runEval real: the GenomeConfig → InferenceRouter adapter.
 *
 * `makeInvokeAgent(deps)` builds the `invokeAgent(prompt, genome)` function
 * `makeRunEval` expects in production. It maps every field of the genome's
 * `GenomeConfig` onto a single `InferenceRouter.complete()` call (or a
 * short chain of calls for `decompositionDepth > 0`) and returns the
 * router's `{content, totalTokens}` shape as `{response, tokens}` — the
 * tokens number is the source of truth for the scorer.
 *
 * Mapping (default behaviour; every part is overridable via deps):
 *
 *   - `temperature`            → `InferenceRequest.temperature`
 *   - `systemPromptId`         → first system message from a versioned pool
 *                                (deps.getSystemPrompt)
 *   - `retrievalStrategy`      → if `deps.recall` is provided, its returned
 *                                block is injected into the user message as
 *                                `[Memory context] … [End memory context]`.
 *                                "episodic" / "semantic" / "graph" /
 *                                "hybrid" name the strategy to the recall
 *                                engine — this module just forwards the
 *                                strategy + query and uses whatever the
 *                                engine returns.
 *   - `contextWindowUsage`     → `maxTokens = floor(budget * usage)` where
 *                                `budget` defaults to 4096. Clamped to
 *                                ≥ 32 so an agent never gets a zero-token
 *                                budget on a 0.1 fraction.
 *   - `decompositionDepth`     → CEILING on the number of parallel sub-calls
 *                                (depth+1, capped at MAX_DECOMPOSITION so a
 *                                pathological genome cannot burst the router
 *                                with 100 completions per prompt). A ceiling
 *                                only: the sub-prompts come from a promoted
 *                                L4 planner module, and without one the
 *                                prompt is not split at all. Responses are
 *                                joined with blank lines.
 *   - `toolPreferenceWeights`  → if a `toolRegistry` is provided, its
 *                                tools are sorted by the genome's weight
 *                                (index-aligned; missing entries are 0),
 *                                tools with weight ≤ 0 are dropped, and
 *                                the top ones are passed as the
 *                                provider-native `nativeTools` /
 *                                `openAITools` field so the model sees
 *                                only the genome's preferred subset.
 *                                Without a registry the weights are
 *                                ignored (the genome is evaluated with
 *                                no tools — the eval suite doesn't need
 *                                them anyway).
 *
 * Session id: `deps.sessionIdFor(genomeId)` defaults to
 * `rsi-eval-${genomeId}`. Picking a stable id per genome means the
 * router's per-conversation token counter accumulates cleanly across the
 * eval suite (the genome pays for its own prompts).
 *
 * Out of scope: this module does NOT drive the long-lived agent loop
 * (tool calls, retries, multi-turn) — the eval suite is intentionally
 * single-shot. A future phase may add a tool-using runner for Tier 1/2
 * specs that need them; until then the genome is graded by a
 * `complete()`-and-stop cycle.
 */

import { stripThinking } from "../../core/strip-thinking.ts";
import type { InferenceRequest, InferenceResponse } from "../../types.ts";
import type { InferenceSpendAuthority } from "../../egress/inference-spend-authority.ts";
import type { GenomeConfig } from "../l1-config/genome.ts";
import type { GenomeSpec } from "../l1-config/population-manager.ts";

/** One agent invocation result — the shape `makeRunEval` expects. */
export interface AgentResponse {
  response: string;
  tokens: number;
}

/**
 * Minimal router contract: production wires an InferenceRouter, tests
 * inject a fake. Only `complete()` is needed.
 */
export interface InvokeRouter {
  complete(req: InferenceRequest): Promise<InferenceResponse>;
}

/**
 * Minimal tool descriptor for the tool-preference-weight filter. The
 * production registry exposes tools in roughly this shape (name +
 * description + JSON-Schema parameters); the filter only needs the
 * name + a sortable key, so tests can pass light-weight stubs.
 */
export interface InvokeTool {
  /** Tool name as it appears in the system prompt / native-tools block. */
  name: string;
  /** Description injected alongside the name (for prompt-style tool
   *  lists; native-tools providers use their own JSON-schema variant). */
  description?: string;
  /** JSON schema for the tool's parameters. Optional — when missing
   *  the tool is only passed to prompt-style providers. */
  parameters?: Record<string, unknown>;
  /** Pre-rendered native-tool shape for providers that need it. Optional. */
  nativeShape?: unknown;
  /** Pre-rendered openai-tool shape for OpenAI-compatible providers. Optional. */
  openAIShape?: unknown;
}

export interface InvokeAgentDeps {
  /** Inference router (production: `InferenceRouter`). */
  router: InvokeRouter;
  /** One hard USD/cancellation scope shared by every completion in this RSI
   *  run. Absent for legacy/tests and non-autonomous callers. */
  spendAuthority?: InferenceSpendAuthority;
  /** Run-scoped cancellation, including manual/local runs without USD scope. */
  signal?: AbortSignal;
  /** System-prompt pool lookup: id → text. Required. */
  getSystemPrompt: (id: number) => string;
  /** Optional recall — when present, the user message is augmented with
   *  a `[Memory context]…[End memory context]` block built from the
   *  strategy-named query. */
  recall?: (opts: {
    strategy: GenomeConfig["retrievalStrategy"];
    query: string;
    sessionId: string;
  }) => Promise<string>;
  /** Base completion budget in tokens; `maxTokens` is computed as
   *  `floor(budget * contextWindowUsage)`. Default 4096. */
  contextBudget?: number;
  /** Optional tool registry — when present, weights are applied. */
  toolRegistry?: { tools: () => InvokeTool[] };
  /** Per-genome session id generator. Default `rsi-eval-${genomeId}`. */
  sessionIdFor?: (genomeId: string) => string;
  /** Hard cap on the decompositionDepth → sub-call count.
   *  Default MAX_DECOMPOSITION (4). */
  maxDecomposition?: number;
  /** Optional L4 planner seam (catalog §1.2). Consulted only when
   *  decomposition actually splits (n > 1); returns the sub-prompts.
   *  Absent, a null reply, or a throw → the builtin `[Part k/N]` split —
   *  byte-identical to the historical behavior (AC10). */
  plan?: (req: { goal: string; maxDepth: number; toolNames: string[] }) => Promise<
    Array<{ description: string; suggestedTools: string[] }> | null
  >;
}

/** Hard ceiling on the depth→sub-call expansion so a single genome
 *  cannot request unbounded parallel completions. */
export const MAX_DECOMPOSITION = 4;

/** Build the production `invokeAgent` the EvalWorker's suite runner
 *  calls per (genome, spec) pair. */
export function makeInvokeAgent(
  deps: InvokeAgentDeps,
): (prompt: string, genome: GenomeSpec) => Promise<AgentResponse> {
  const budget = deps.contextBudget ?? 4096;
  const maxDepth = deps.maxDecomposition ?? MAX_DECOMPOSITION;
  const sessionIdFor =
    deps.sessionIdFor ?? ((id: string) => `rsi-eval-${id}`);
  return async (prompt, genome) => {
    const config = genome.config;
    if (!config) {
      // A genome without a config is a bookkeeping bug — surface it
      // loudly rather than silently returning an empty response.
      throw new Error(
        `invokeAgent: genome '${genome.id}' has no config — selection should set one at birth`,
      );
    }
    return runOnce({
      router: deps.router,
      spendAuthority: deps.spendAuthority,
      signal: deps.signal,
      getSystemPrompt: deps.getSystemPrompt,
      recall: deps.recall,
      contextBudget: budget,
      maxDecomposition: maxDepth,
      toolRegistry: deps.toolRegistry,
      sessionId: sessionIdFor(genome.id),
      prompt,
      config,
      plan: deps.plan,
    });
  };
}

/**
 * The answer, as a grader should see it.
 *
 * Reasoning models emit chain-of-thought inline, and the OpenAI-compatible chat
 * templates for MiniMax / DeepSeek-R1 bake the opening `<think>` into the
 * prompt, so a completion arrives as `reasoning…</think>answer`. The agent loop
 * has always stripped that before the user (or memory) sees it — the eval path
 * was the one place that did not, so Tier 0 graded the raw string.
 *
 * The cost of that was total: `tier0/json_format` scored
 * `<think>7</think> {"answer": 7}` as malformed and `tier0/constraint_count`
 * counted the reasoning's words, so every candidate breached the Tier 0 sanity
 * floor and was rejected by the confidence gate. Nothing could ever be promoted
 * — not because the candidates were bad, but because the grader was reading the
 * model's notes instead of its answer.
 *
 * Stripping here, at the one point every eval response passes through, keeps the
 * grader looking at exactly what a user would get. Both return paths of
 * `runOnce` go through it; the token count deliberately does not change, because
 * the reasoning tokens were really spent and the cost component must reflect it.
 *
 * An answer that strips to empty stays empty and fails its spec. That is the
 * honest outcome: a response truncated mid-reasoning contains no answer.
 */
function gradableAnswer(raw: string): string {
  return stripThinking(raw);
}

/** Internal: run the actual completion(s) for one (prompt, config) pair. */
async function runOnce(args: {
  router: InvokeRouter;
  spendAuthority?: InferenceSpendAuthority;
  signal?: AbortSignal;
  getSystemPrompt: (id: number) => string;
  recall: InvokeAgentDeps["recall"];
  contextBudget: number;
  maxDecomposition: number;
  toolRegistry: InvokeAgentDeps["toolRegistry"];
  sessionId: string;
  prompt: string;
  config: GenomeConfig;
  plan?: InvokeAgentDeps["plan"];
}): Promise<AgentResponse> {
  const systemPrompt = args.getSystemPrompt(args.config.systemPromptId);
  const recallBlock = args.recall
    ? await args.recall({
        strategy: args.config.retrievalStrategy,
        query: args.prompt,
        sessionId: args.sessionId,
      })
    : "";
  const userContent = recallBlock
    ? `${recallBlock}\n\n${args.prompt}`
    : args.prompt;

  // Floor 256: a genome with low contextWindowUsage was truncating CORRECT
  // answers (tier2/plan_make_tea cut at 130 tokens) — the floor keeps the
  // eval fair while usage still differentiates genomes above it.
  const maxTokens = Math.max(
    256,
    Math.floor(args.contextBudget * args.config.contextWindowUsage),
  );

  const { nativeTools, openAITools } = selectTools(
    args.toolRegistry?.tools() ?? [],
    args.config.toolPreferenceWeights,
  );

  const baseRequest: Omit<InferenceRequest, "messages"> = {
    sessionId: args.sessionId,
    maxTokens,
    temperature: args.config.temperature,
    cachePrompt: false, // one-shot evals have no stable prefix worth caching
    skipBudgetCheck: false,
    ...(args.spendAuthority ? { spendAuthority: args.spendAuthority } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
    ...(nativeTools ? { nativeTools: nativeTools as InferenceRequest["nativeTools"] } : {}),
    ...(openAITools ? { openAITools: openAITools as InferenceRequest["openAITools"] } : {}),
  };

  // Decomposition: `depth+1` sub-prompts at most (capped at
  // maxDecomposition), and only ever as many as a planner actually produces.
  //
  // The L4 planner seam (§1.2) is what turns one goal into several; without a
  // promoted module there is nothing here that can split anything, so the
  // answer is one call. The old fallback manufactured `n` copies of the same
  // prompt under a `[Part k/N]` prefix and joined the `n` identical answers —
  // see `builtinPlanSteps` for what that did to every genome with
  // `decompositionDepth > 0`.
  const n = Math.min(args.maxDecomposition, args.config.decompositionDepth + 1);
  let parts: string[] | null = null;
  if (n > 1 && args.plan) {
    try {
      const steps = await args.plan({
        goal: userContent,
        maxDepth: n,
        toolNames: (args.toolRegistry?.tools() ?? []).map((t) => t.name),
      });
      if (steps && steps.length > 0) {
        parts = steps.slice(0, n).map((s) => s.description);
      }
    } catch {
      parts = null; // a broken planner must not cost the eval its answer
    }
  }
  parts ??= [userContent];

  // Sub-calls run concurrently — the router itself is rate-limit-aware, and
  // the eval suite is the canonical example of the engine's pool concurrency.
  const subCalls = parts.map((content, k) =>
    args.router.complete({
      ...baseRequest,
      // The first sub-call uses the canonical per-genome sessionId so
      // the router's per-conversation token counter naturally
      // accumulates across the suite (the genome pays for its own
      // prompts under one key). Parallel siblings get a `#p2`, `#p3`,
      // … suffix so they don't conflate with the primary counter; the
      // caller can still correlate by the shared prefix.
      sessionId: k === 0 ? args.sessionId : `${args.sessionId}#p${k + 1}`,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content },
      ],
    }),
  );
  const responses = await Promise.all(subCalls);
  return {
    // Strip per sub-response, not after joining: a dangling `<think>` in the
    // first part would otherwise swallow every later part's answer too.
    response: responses.map((r) => gradableAnswer(r.content)).join("\n\n"),
    tokens: responses.reduce((s, r) => s + r.totalTokens, 0),
  };
}

/**
 * Sort tools by the genome's `toolPreferenceWeights` (index-aligned),
 * drop weight ≤ 0 entries, and project to the provider-native shapes.
 *
 * Mapping: `weights[i]` corresponds to `tools[i]`. If `weights` is
 * shorter than `tools`, the missing tools get weight 0 and are
 * dropped. If `weights` is longer than `tools`, the surplus weights
 * are ignored. This is intentional: tool additions / removals are a
 * breaking change for the genome's whole pre-existing lineage, so the
 * simpler "by index" rule keeps things deterministic.
 */
export function selectTools(
  tools: InvokeTool[],
  weights: number[],
): { nativeTools: unknown[]; openAITools: unknown[] } {
  const ordered = tools
    .map((t, i) => ({ tool: t, weight: weights[i] ?? 0 }))
    .filter((x) => x.weight > 0)
    .sort((a, b) => b.weight - a.weight);

  const nativeTools: unknown[] = [];
  const openAITools: unknown[] = [];
  for (const { tool } of ordered) {
    if (tool.nativeShape) nativeTools.push(tool.nativeShape);
    if (tool.openAIShape) openAITools.push(tool.openAIShape);
  }
  return { nativeTools, openAITools };
}
