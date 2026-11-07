/**
 * A bare turn — the chosen model with none of Cinderpaw around it.
 *
 * It exists for one comparison: the same model, the same prompt, from the same
 * app, once alone and once inside the harness. The comparison is only honest
 * if nothing of the harness reaches the model, so a bare turn sends exactly the
 * person's message: no system prompt (no SOUL, no AGENTS.md), no tool schemas,
 * no memory or skills, no history, and one completion with no loop after it.
 * What stays is what belongs to the model itself: its Effort, temperature and
 * max tokens from the controls.
 *
 * DEV ONLY (3 Nov 2026, Darius: "nu ajunge in release"). The desktop shows the
 * switch only in a dev build; nothing else sends `bare`.
 *
 * ponytail: no history, every bare message is a fresh call. The one test this
 * is for is a single prompt; a bare multi-turn chat would need the transcript.
 */

import type { InferenceRequest, InferenceResponse, OutboundEvent } from "../types.ts";
import { sanitizeInferParams } from "./agent-loop.ts";

export interface BareRouter {
  complete(req: InferenceRequest): Promise<InferenceResponse>;
}

export async function runBareTurn(
  router: BareRouter,
  turn: {
    sessionId: string;
    messageId: string;
    text: string;
    emit: (event: OutboundEvent) => void;
    images?: string[];
    inferParams?: { temperature?: unknown; max_tokens?: unknown; effort?: unknown };
    /**
     * Cinderpaw's own line for the PERSON, written after the model is done and
     * never shown to it (e.g. a link to see the page it wrote). It helps the
     * viewer, not the model, so the comparison stays honest.
     */
    afterword?: (answer: string) => Promise<string | undefined>;
  },
): Promise<string> {
  const { sessionId, messageId: id, text, emit, images } = turn;
  const params = turn.inferParams ? sanitizeInferParams(turn.inferParams) : {};
  try {
    const res = await router.complete({
      sessionId,
      messages: [{ role: "user", content: text, ...(images?.length ? { images } : {}) }],
      maxTokens: params.maxTokens,
      temperature: params.temperature,
      ...(params.reasoningEffort ? { reasoningEffort: params.reasoningEffort } : {}),
      onToken: (token) => emit({ type: "chunk", id, content: token, traceId: id }),
    });
    const note = await turn.afterword?.(res.content).catch(() => undefined);
    const content = note ? `${res.content}\n\n${note}` : res.content;
    if (note) emit({ type: "chunk", id, content: `\n\n${note}`, traceId: id });
    emit({ type: "done", id, content, stopped: false, traceId: id, outcome: "completed", incomplete: false });
    return content;
  } catch (err) {
    const content = "The model did not answer this bare call. Nothing of Cinderpaw was in the way: the error is the provider's.";
    emit({
      type: "done", id, content, stopped: false, traceId: id, outcome: "no_answer", incomplete: false,
      diagnostic: `bare turn failed: ${String((err as Error)?.message ?? err)}`,
    });
    return content;
  }
}
