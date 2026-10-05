/**
 * A real model for the budget broker (AgentLoop spec §4.4, §24): one
 * OpenRouter chat-completions endpoint. The broker pins the model id, clamps
 * max_tokens and charges from the prices here, so this file only carries the
 * request and turns a failed one into a throw.
 *
 * RESEARCH ONLY (spec §4.7). The key comes from the caller (the runner reads
 * it from the OS keychain); it never enters a cell: the sidecar in the cell
 * talks to the relay, the relay to the broker, the broker to this.
 */

import type { BrokerModel, ChatAnswer, ChatBody } from "./task-budget.ts";

/** The owner's research model (5 Oct 2026). Prices in $ per million tokens,
 *  read from OpenRouter's model list on 5 Oct; re-check before a campaign. */
export const MUSE_SPARK_CONTRIBUTOR = { id: "meta/muse-spark-1.3-contributor", usdPerMInput: 0.1, usdPerMOutput: 0.2 };

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const CALL_MS = 180_000;

export function openRouterModel(
  model: { id: string; usdPerMInput: number; usdPerMOutput: number },
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): BrokerModel {
  if (!apiKey) throw new Error("no OpenRouter key: the runner reads it from the OS keychain");
  return {
    ...model,
    async call(body: ChatBody): Promise<ChatAnswer> {
      const res = await fetchFn(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        // Never streamed here: the executor turns the whole answer into SSE
        // for the sidecar, and usage arrives only on a whole answer.
        body: JSON.stringify({ ...body, stream: false }),
        signal: AbortSignal.timeout(CALL_MS),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 300)}`);
      const answer = JSON.parse(text) as ChatAnswer & { error?: { message?: string } };
      // OpenRouter can answer 200 with an error body (provider failure).
      if (answer.error) throw new Error(`OpenRouter: ${answer.error.message ?? "provider error"}`);
      return answer;
    },
  };
}
