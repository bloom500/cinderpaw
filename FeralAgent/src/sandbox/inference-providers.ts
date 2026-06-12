/**
 * Inference providers — pluggable LLM backends for InferenceRouter.
 *
 * Each provider implements InferenceProvider, which has a single method:
 *   complete(target, req, isFallback) → InferenceResponse
 *
 * The router is the orchestrator (budget, audit, fallback, abort).
 * Providers are pure transport — they know nothing about budget or sessions.
 *
 * Adding a new provider:
 *   1. Implement InferenceProvider.
 *   2. Export the class from this file.
 *   3. Add a branch in InferenceRouter.#callTarget (or pass it via providerMap).
 */

import { countTokens } from "../core/tokenizer.ts";
import type {
  ChatMessage,
  InferenceRequest,
  InferenceResponse,
  ModelTarget,
} from "../types.ts";

// Defined here (not imported from inference-router) to avoid a circular dep.
// inference-router re-exports its own InferenceError class; both throw the
// same shape but are separate class instances. Callers catch by name or message.
class InferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InferenceError";
  }
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/**
 * A single pluggable LLM backend. Receives a fully-resolved target and an
 * already-wired InferenceRequest (signal chained, budgets already checked).
 * Must never throw BudgetExhaustedError — that belongs in the router.
 */
export interface InferenceProvider {
  complete(
    target: ModelTarget,
    req: InferenceRequest,
    isFallback: boolean,
  ): Promise<InferenceResponse>;
}

// ---------------------------------------------------------------------------
// Ollama provider
// ---------------------------------------------------------------------------

export class OllamaProvider implements InferenceProvider {
  async complete(
    target: ModelTarget,
    req: InferenceRequest,
    isFallback: boolean,
  ): Promise<InferenceResponse> {
    const url = `${trimSlash(target.baseUrl)}/api/chat`;
    return req.onToken
      ? this.#stream(url, target, req, isFallback)
      : this.#nonStream(url, target, req, isFallback);
  }

  async #nonStream(
    url: string,
    target: ModelTarget,
    req: InferenceRequest,
    isFallback: boolean,
  ): Promise<InferenceResponse> {
    // P5 fix: `num_ctx` is the model's context window (KV cache size), not
    // the per-completion output cap. Tying it to `req.maxTokens` silently
    // forced a 16,384-token context window on every Ollama call when the
    // main loop's maxTokensPerCall was raised. Read it from a dedicated
    // env var with a sensible default instead. Operators can override with
    // FERAL_OLLAMA_NUM_CTX to match the model card.
    const numCtx = readOllamaNumCtx();
    const useNativeTools = !!(req.openAITools && req.openAITools.length > 0);
    const messages = req.messages.map((m) => {
      if (useNativeTools && m.role === "system") {
        return { role: "system", content: stripToolsFromSystemPrompt(m.content) };
      }
      return toOllamaMessage(m);
    });

    const body: Record<string, any> = {
      model: target.model,
      messages,
      stream: false,
      options: {
        temperature: req.temperature ?? 0.7,
        num_ctx: numCtx,
        ...(req.maxTokens ? { num_predict: req.maxTokens } : {}),
      },
      ...(req.cachePrompt !== undefined ? { cache_prompt: req.cachePrompt } : {}),
    };
    if (useNativeTools) {
      body.tools = req.openAITools;
    }

    const raw = await postJson(url, body, undefined, req.signal);
    let content: string =
      (raw as { message?: { content?: string } }).message?.content ?? "";

    const toolCalls = (raw as { message?: { tool_calls?: any[] } }).message?.tool_calls;
    if (toolCalls && toolCalls.length > 0) {
      const firstCall = toolCalls[0];
      if (firstCall.function) {
        const fn = firstCall.function;
        let args = {};
        if (typeof fn.arguments === "string") {
          try { args = JSON.parse(fn.arguments); } catch {}
        } else if (fn.arguments && typeof fn.arguments === "object") {
          args = fn.arguments;
        }
        const tag = `\n<tool_call>\n${JSON.stringify({ name: fn.name, args })}\n</tool_call>`;
        content = trimDanglingToolCallTag(content) + tag;
      }
    }

    const promptTokens =
      (raw as { prompt_eval_count?: number }).prompt_eval_count ??
      estimateTokens(req.messages);
    const completionTokens =
      (raw as { eval_count?: number }).eval_count ?? estimateText(content);

    return { content, promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, model: target.model, usedFallback: isFallback };
  }

  async #stream(
    url: string,
    target: ModelTarget,
    req: InferenceRequest,
    isFallback: boolean,
  ): Promise<InferenceResponse> {
    // P5 fix: see #nonStream — `num_ctx` must come from its own setting,
    // never from the per-completion output cap.
    const numCtx = readOllamaNumCtx();
    const useNativeTools = !!(req.openAITools && req.openAITools.length > 0);
    const messages = req.messages.map((m) => {
      if (useNativeTools && m.role === "system") {
        return { role: "system", content: stripToolsFromSystemPrompt(m.content) };
      }
      return toOllamaMessage(m);
    });

    const body: Record<string, any> = {
      model: target.model,
      messages,
      stream: true,
      options: {
        temperature: req.temperature ?? 0.7,
        num_ctx: numCtx,
        ...(req.maxTokens ? { num_predict: req.maxTokens } : {}),
      },
      ...(req.cachePrompt !== undefined ? { cache_prompt: req.cachePrompt } : {}),
    };
    if (useNativeTools) {
      body.tools = req.openAITools;
    }

    const { controller, cleanup } = idleAbortController(300_000, req.signal);
    let content = "";
    let promptTokens = 0;
    let completionTokens = 0;

    const ollamaToolCallsAccumulator: {
      name?: string;
      argumentsString: string;
      argumentsObject?: Record<string, any>;
    }[] = [];

    try {
      const res = await fetchStream(url, body, {}, controller.signal);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      const processLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let chunk: unknown;
        try { chunk = JSON.parse(trimmed); } catch { return; }

        const token = (chunk as { message?: { content?: string } }).message?.content ?? "";
        if (token) { content += token; req.onToken!(token); }

        const toolCalls = (chunk as { message?: { tool_calls?: any[] } }).message?.tool_calls;
        if (toolCalls) {
          for (let idx = 0; idx < toolCalls.length; idx++) {
            const tc = toolCalls[idx];
            const acc = (ollamaToolCallsAccumulator[idx] ??= { argumentsString: "" });
            if (tc.function?.name) {
              acc.name = tc.function.name;
            }
            if (tc.function?.arguments) {
              if (typeof tc.function.arguments === "string") {
                acc.argumentsString += tc.function.arguments;
              } else if (typeof tc.function.arguments === "object") {
                acc.argumentsObject = {
                  ...acc.argumentsObject,
                  ...tc.function.arguments
                };
              }
            }
          }
        }

        if ((chunk as { done?: boolean }).done === true) {
          promptTokens = (chunk as { prompt_eval_count?: number }).prompt_eval_count ?? estimateTokens(req.messages);
          completionTokens = (chunk as { eval_count?: number }).eval_count ?? estimateText(content);
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        controller.resetIdle();
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      }
      if (buf.trim()) processLine(buf);

      if (ollamaToolCallsAccumulator[0] && ollamaToolCallsAccumulator[0].name) {
        const first = ollamaToolCallsAccumulator[0];
        let args = {};
        if (first.argumentsObject) {
          args = first.argumentsObject;
        } else if (first.argumentsString) {
          try { args = JSON.parse(first.argumentsString); } catch {}
        }
        const tag = `\n<tool_call>\n${JSON.stringify({ name: first.name, args })}\n</tool_call>`;
        content = trimDanglingToolCallTag(content) + tag;
        req.onToken!(tag);
      }
    } finally {
      cleanup();
    }

    if (!promptTokens) promptTokens = estimateTokens(req.messages);
    if (!completionTokens) completionTokens = estimateText(content);
    return { content, promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, model: target.model, usedFallback: isFallback };
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible provider
// ---------------------------------------------------------------------------

export class OpenAICompatibleProvider implements InferenceProvider {
  async complete(
    target: ModelTarget,
    req: InferenceRequest,
    isFallback: boolean,
  ): Promise<InferenceResponse> {
    const url = `${trimSlash(target.baseUrl)}/v1/chat/completions`;
    return req.onToken
      ? this.#stream(url, target, req, isFallback)
      : this.#nonStream(url, target, req, isFallback);
  }

  async #nonStream(
    url: string,
    target: ModelTarget,
    req: InferenceRequest,
    isFallback: boolean,
  ): Promise<InferenceResponse> {
    const authHeaders: Record<string, string> = target.apiKey
      ? { Authorization: `Bearer ${target.apiKey}` }
      : {};

    const useNativeTools = !!(req.openAITools && req.openAITools.length > 0);
    const messages = req.messages.map((m) => {
      if (useNativeTools && m.role === "system") {
        return { role: "system", content: stripToolsFromSystemPrompt(m.content) };
      }
      return toOpenAIMessage(m);
    });

    const body: Record<string, any> = {
      model: target.model,
      messages,
      temperature: req.temperature ?? 0.7,
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      ...feralExtensionBody(target, req),
      stream: false,
    };
    if (useNativeTools) {
      body.tools = req.openAITools;
      body.tool_choice = "auto";
    }

    const raw = (await postJson(url, body, authHeaders, req.signal)) as {
      choices?: {
        message?: {
          content?: string;
          reasoning_content?: string;
          tool_calls?: any[];
        };
      }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    let content = raw.choices?.[0]?.message?.content ?? "";
    // Reasoning models on OpenAI-compatible servers (NVIDIA NIM, DeepSeek,
    // stepfun, QwQ, …) return chain-of-thought in a separate
    // `reasoning_content` field. Without folding it back in, a turn whose
    // visible answer is empty (e.g. all budget spent reasoning) looks like
    // a fully empty response to the agent loop. Wrap it in <think> tags —
    // the exact format local thinking models emit — so stripThinking()
    // and the frontend's live thinking-splitter handle it unchanged.
    const reasoning = raw.choices?.[0]?.message?.reasoning_content ?? "";
    if (reasoning) {
      content = `<think>${reasoning}</think>${content}`;
    }
    const toolCalls = raw.choices?.[0]?.message?.tool_calls;
    if (toolCalls && toolCalls.length > 0) {
      const firstCall = toolCalls[0];
      if (firstCall.function) {
        const fn = firstCall.function;
        let args = {};
        if (typeof fn.arguments === "string") {
          try { args = JSON.parse(fn.arguments); } catch {}
        } else if (fn.arguments && typeof fn.arguments === "object") {
          args = fn.arguments;
        }
        const tag = `\n<tool_call>\n${JSON.stringify({ name: fn.name, args })}\n</tool_call>`;
        content = trimDanglingToolCallTag(content) + tag;
      }
    }
    const promptTokens = raw.usage?.prompt_tokens ?? estimateTokens(req.messages);
    const completionTokens = raw.usage?.completion_tokens ?? estimateText(content);
    return { content, promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, model: target.model, usedFallback: isFallback };
  }

  async #stream(
    url: string,
    target: ModelTarget,
    req: InferenceRequest,
    isFallback: boolean,
  ): Promise<InferenceResponse> {
    const useNativeTools = !!(req.openAITools && req.openAITools.length > 0);
    const messages = req.messages.map((m) => {
      if (useNativeTools && m.role === "system") {
        return { role: "system", content: stripToolsFromSystemPrompt(m.content) };
      }
      return toOpenAIMessage(m);
    });

    const body: Record<string, any> = {
      model: target.model,
      messages,
      temperature: req.temperature ?? 0.7,
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      ...feralExtensionBody(target, req),
      stream: true,
    };
    if (useNativeTools) {
      body.tools = req.openAITools;
      body.tool_choice = "auto";
    }

    const authHeaders: Record<string, string> = target.apiKey
      ? { Authorization: `Bearer ${target.apiKey}` }
      : {};
    const { controller, cleanup } = idleAbortController(300_000, req.signal);
    let content = "";
    let promptTokens = 0;
    let completionTokens = 0;

    const toolCallsAccumulator: {
      id?: string;
      name?: string;
      arguments: string;
    }[] = [];

    // Reasoning models on OpenAI-compatible servers (NVIDIA NIM, DeepSeek,
    // stepfun, QwQ, …) stream chain-of-thought as `delta.reasoning_content`,
    // separate from `delta.content`. We fold it into the text stream wrapped
    // in <think> tags — the exact format local thinking models emit — so the
    // frontend's live thinking-splitter shows it as reasoning and
    // stripThinking() removes it from the final answer. Without this, a turn
    // that reasons before answering streams NOTHING and an all-reasoning
    // turn surfaces as "(The model returned an empty response.)".
    let inReasoning = false;
    const emitPiece = (piece: string): void => {
      content += piece;
      req.onToken!(piece);
    };
    const closeReasoning = (): void => {
      if (inReasoning) {
        inReasoning = false;
        emitPiece("</think>");
      }
    };

    try {
      const res = await fetchStream(url, body, authHeaders, controller.signal);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      const processLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) return;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") return;
        let chunk: unknown;
        try { chunk = JSON.parse(data); } catch { return; }

        const delta = (chunk as {
          choices?: { delta?: { content?: string; reasoning_content?: string } }[];
        }).choices?.[0]?.delta;

        const reasoningTok = delta?.reasoning_content ?? "";
        if (reasoningTok) {
          if (!inReasoning) {
            inReasoning = true;
            emitPiece("<think>");
          }
          emitPiece(reasoningTok);
        }

        const token = delta?.content ?? "";
        if (token) {
          closeReasoning();
          emitPiece(token);
        }

        const toolCalls = (chunk as { choices?: { delta?: { tool_calls?: any[] } }[] }).choices?.[0]?.delta?.tool_calls;
        if (toolCalls) {
          for (const tc of toolCalls) {
            const idx = tc.index ?? 0;
            if (!toolCallsAccumulator[idx]) {
              toolCallsAccumulator[idx] = { arguments: "" };
            }
            if (tc.id) toolCallsAccumulator[idx].id = tc.id;
            if (tc.function?.name) toolCallsAccumulator[idx].name = tc.function.name;
            if (tc.function?.arguments) {
              toolCallsAccumulator[idx].arguments += tc.function.arguments;
            }
          }
        }

        const usage = (chunk as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
        if (usage) {
          if (usage.prompt_tokens) promptTokens = usage.prompt_tokens;
          if (usage.completion_tokens) completionTokens = usage.completion_tokens;
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        controller.resetIdle();
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      }
      if (buf.trim()) processLine(buf);
      // A turn can end while still inside reasoning (all-reasoning turn, or
      // reasoning followed directly by a tool call) — close the tag so the
      // <think> block is well-formed for stripThinking()/the frontend.
      closeReasoning();

      if (toolCallsAccumulator[0] && toolCallsAccumulator[0].name) {
        const first = toolCallsAccumulator[0];
        let args = {};
        try { args = JSON.parse(first.arguments || "{}"); } catch {}
        const tag = `\n<tool_call>\n${JSON.stringify({ name: first.name, args })}\n</tool_call>`;
        content = trimDanglingToolCallTag(content) + tag;
        req.onToken!(tag);
      }
    } finally {
      cleanup();
    }

    if (!promptTokens) promptTokens = estimateTokens(req.messages);
    if (!completionTokens) completionTokens = estimateText(content);
    return { content, promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, model: target.model, usedFallback: isFallback };
  }
}

// ---------------------------------------------------------------------------
// Anthropic provider
// ---------------------------------------------------------------------------

export class AnthropicProvider implements InferenceProvider {
  async complete(
    target: ModelTarget,
    req: InferenceRequest,
    isFallback: boolean,
  ): Promise<InferenceResponse> {
    const url = `${trimSlash(target.baseUrl)}/v1/messages`;
    return req.onToken
      ? this.#stream(url, target, req, isFallback)
      : this.#nonStream(url, target, req, isFallback);
  }

  async #nonStream(
    url: string,
    target: ModelTarget,
    req: InferenceRequest,
    isFallback: boolean,
  ): Promise<InferenceResponse> {
    const { systemText, userMessages } = splitAnthropicMessages(req.messages);
    const body: Record<string, unknown> = {
      model: target.model,
      max_tokens: req.maxTokens ?? 4096,
      messages: userMessages,
      temperature: req.temperature ?? 0.7,
    };
    if (systemText) body.system = systemText;
    // A3: use native function calling when tool definitions are provided.
    if (req.nativeTools && req.nativeTools.length > 0) body.tools = req.nativeTools;

    const authHeaders: Record<string, string> = { "anthropic-version": "2023-06-01" };
    if (target.apiKey) authHeaders["x-api-key"] = target.apiKey;

    const raw = (await postJson(url, body, authHeaders, req.signal)) as {
      content?: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    // A3: collect both text and tool_use blocks.
    let content = raw.content?.find((b) => b.type === "text")?.text ?? "";
    for (const block of raw.content ?? []) {
      if (block.type === "tool_use" && block.name) {
        // Serialise as <tool_call> XML so Pass 0 of parseResponse picks it up.
        const args = block.input ?? {};
        content += `\n<tool_call>\n${JSON.stringify({ name: block.name, args })}\n</tool_call>`;
      }
    }
    const promptTokens = raw.usage?.input_tokens ?? estimateTokens(req.messages);
    const completionTokens = raw.usage?.output_tokens ?? estimateText(content);
    return { content, promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, model: target.model, usedFallback: isFallback };
  }

  async #stream(
    url: string,
    target: ModelTarget,
    req: InferenceRequest,
    isFallback: boolean,
  ): Promise<InferenceResponse> {
    const { systemText, userMessages } = splitAnthropicMessages(req.messages);
    const body: Record<string, unknown> = {
      model: target.model,
      max_tokens: req.maxTokens ?? 4096,
      messages: userMessages,
      temperature: req.temperature ?? 0.7,
      stream: true,
    };
    if (systemText) body.system = systemText;
    // A3: use native function calling when tool definitions are provided.
    if (req.nativeTools && req.nativeTools.length > 0) body.tools = req.nativeTools;

    const headers: Record<string, string> = {
      "anthropic-version": "2023-06-01",
      ...(target.apiKey ? { "x-api-key": target.apiKey } : {}),
    };

    const { controller, cleanup } = idleAbortController(300_000, req.signal);
    let content = "";
    let inputTokens = 0;
    let outputTokens = 0;

    // A3: per-block accumulator for tool_use streaming.
    // Anthropic streams tool_use blocks as:
    //   content_block_start  {type:"tool_use", id, name}
    //   content_block_delta  {delta:{type:"input_json_delta", partial_json:"..."}}
    //   content_block_stop
    // We accumulate partial_json per block index, then emit a <tool_call>
    // at content_block_stop.
    type ToolBlock = { name: string; json: string };
    const toolBlocks = new Map<number, ToolBlock>();
    let activeBlockIndex = -1;
    let activeBlockType = "";

    try {
      const res = await fetchStream(url, body, headers, controller.signal);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      const processLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) return;
        const data = trimmed.slice(5).trim();
        let chunk: unknown;
        try { chunk = JSON.parse(data); } catch { return; }

        const type = (chunk as { type?: string }).type;
        if (type === "content_block_start") {
          const idx = (chunk as { index?: number }).index ?? -1;
          const cb = (chunk as { content_block?: { type?: string; name?: string } }).content_block;
          activeBlockIndex = idx;
          activeBlockType = cb?.type ?? "";
          if (cb?.type === "tool_use" && cb.name) {
            toolBlocks.set(idx, { name: cb.name, json: "" });
          }
        } else if (type === "content_block_delta") {
          const delta = (chunk as { delta?: { type?: string; text?: string; partial_json?: string } }).delta;
          if (!delta) return;
          if (delta.type === "text_delta") {
            const token = delta.text ?? "";
            if (token) { content += token; req.onToken!(token); }
          } else if (delta.type === "input_json_delta") {
            // Accumulate partial JSON for the current tool_use block.
            const block = toolBlocks.get(activeBlockIndex);
            if (block) block.json += delta.partial_json ?? "";
          }
        } else if (type === "content_block_stop") {
          if (activeBlockType === "tool_use") {
            const block = toolBlocks.get(activeBlockIndex);
            if (block) {
              let args: unknown = {};
              try { args = JSON.parse(block.json || "{}"); } catch { args = {}; }
              const tag = `\n<tool_call>\n${JSON.stringify({ name: block.name, args })}\n</tool_call>`;
              content += tag;
              // Emit synthetic tokens so streaming UI sees the tool call.
              req.onToken!(tag);
            }
          }
          activeBlockIndex = -1;
          activeBlockType = "";
        } else if (type === "message_start") {
          inputTokens = (chunk as { message?: { usage?: { input_tokens?: number } } }).message?.usage?.input_tokens ?? 0;
        } else if (type === "message_delta") {
          outputTokens = (chunk as { usage?: { output_tokens?: number } }).usage?.output_tokens ?? 0;
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        controller.resetIdle();
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      }
      if (buf.trim()) processLine(buf);
    } finally {
      cleanup();
    }

    const promptTokens = inputTokens || estimateTokens(req.messages);
    const completionTokens = outputTokens || estimateText(content);
    return { content, promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, model: target.model, usedFallback: isFallback };
  }
}

// ---------------------------------------------------------------------------
// Shared helpers (moved here from inference-router.ts)
// ---------------------------------------------------------------------------

/**
 * A3 regression fix: Remove text-based tool definitions and instructions from
 * the system prompt when native function calling is used. This prevents the
 * model from getting confused or attempting to emit legacy XML blocks.
 */
export function stripToolsFromSystemPrompt(systemPrompt: string): string {
  const lines = systemPrompt.split("\n");
  const resultLines: string[] = [];
  let inStrippedSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("## Available tools") || line.startsWith("## How to call a tool")) {
      inStrippedSection = true;
      continue;
    }
    if (inStrippedSection && line.startsWith("## ") && !line.startsWith("## Available tools") && !line.startsWith("## How to call a tool")) {
      inStrippedSection = false;
    }
    if (line === "No tools are available.") {
      continue;
    }
    if (!inStrippedSection) {
      resultLines.push(line);
    }
  }
  return resultLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}


/**
 * Resolve the Ollama `num_ctx` value (context-window size in tokens).
 *
 * P5 fix: this used to be `req.maxTokens`, which silently conflated the
 * per-completion output cap with the model's KV-cache size and forced a
 * 16,384-token context window for every Ollama call. The two parameters
 * are now sourced independently:
 *
 *   - num_predict  = req.maxTokens            (per-completion output cap)
 *   - num_ctx      = FERAL_OLLAMA_NUM_CTX     (context window, default 8192)
 *
 * Operators targeting a specific model card should set FERAL_OLLAMA_NUM_CTX
 * to match (e.g. 32768 for a Qwen2.5-32B context, 131072 for a long-context
 * model). The default 8192 is a safe middle ground for the 7B-class
 * models the bundled llama.cpp engine targets.
 */
function readOllamaNumCtx(): number {
  const raw = process.env.FERAL_OLLAMA_NUM_CTX;
  if (raw === undefined || raw === "") return 8192;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 8192;
  return n;
}

/**
 * Idle-timeout AbortController. Resets on each resetIdle() call; fires only
 * when no progress arrives for `idleMs` milliseconds. The caller MUST call
 * cleanup() in a finally block to avoid leaking the timer.
 */
function idleAbortController(
  idleMs: number,
  externalSignal?: AbortSignal,
): { controller: AbortController & { resetIdle(): void }; cleanup(): void } {
  const ac = new AbortController() as AbortController & { resetIdle(): void };
  // #13: abort with a typed error, NOT a bare string. fetch rejects with
  // `signal.reason`; a string reason surfaced upstream as a generic
  // AbortError-ish failure that the agent loop misread as a user-initiated
  // stop — the stream just ended "stopped" with no explanation. The named
  // error lets the loop tell "engine went silent" apart from "user clicked
  // stop" and show the user why the generation died.
  const idleError = () => {
    const e = new Error(
      `inference stream stalled: no data received for ${Math.round(idleMs / 1000)}s`,
    );
    e.name = "IdleTimeoutError";
    return e;
  };
  let timer: ReturnType<typeof setTimeout> = setTimeout(() => ac.abort(idleError()), idleMs);

  ac.resetIdle = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ac.abort(idleError()), idleMs);
  };

  let onExt: (() => void) | null = null;
  if (externalSignal) {
    onExt = () => {
      clearTimeout(timer);
      ac.abort(externalSignal.reason);
    };
    if (externalSignal.aborted) {
      onExt();
    } else {
      externalSignal.addEventListener("abort", onExt, { once: true });
    }
  }

  const cleanup = () => {
    clearTimeout(timer);
    if (externalSignal && onExt) {
      externalSignal.removeEventListener("abort", onExt);
    }
  };

  return { controller: ac, cleanup };
}

async function fetchStream(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Response> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new InferenceError(
      `inference endpoint ${url} returned ${res.status}: ${detail.slice(0, 200)}`,
    );
  }
  if (!res.body) throw new InferenceError("no response body for streaming");
  return res;
}

export async function postJson(
  url: string,
  body: unknown,
  extraHeaders?: Record<string, string>,
  externalSignal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300_000);
  let onExt: (() => void) | null = null;
  if (externalSignal) {
    onExt = () => { clearTimeout(timer); controller.abort(externalSignal.reason); };
    if (externalSignal.aborted) onExt();
    else externalSignal.addEventListener("abort", onExt, { once: true });
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...extraHeaders },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new InferenceError(`inference endpoint ${url} returned ${res.status}: ${detail.slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
    if (externalSignal && onExt) externalSignal.removeEventListener("abort", onExt);
  }
}

export function toProviderMessage(m: ChatMessage): { role: string; content: string } {
  const role = m.role === "tool" ? "user" : m.role;
  const content = m.role === "tool" ? `[tool:${m.name ?? "unknown"}] ${m.content}` : m.content;
  return { role, content };
}

/** Split a `data:<mime>;base64,<data>` URL into its parts, or null if malformed. */
export function parseDataUrl(url: string): { mediaType: string; base64: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (!match) return null;
  return { mediaType: match[1]!, base64: match[2]! };
}

/**
 * OpenAI-compatible message with optional vision parts. Messages without
 * images keep the plain-string content shape (required for byte-stable
 * prompts / KV-cache reuse and maximum server compatibility); messages WITH
 * images use the standard `image_url` content-parts array that OpenAI,
 * OpenRouter, Google's OpenAI endpoint, and vision-enabled llama.cpp accept.
 */
export function toOpenAIMessage(m: ChatMessage): { role: string; content: unknown } {
  const base = toProviderMessage(m);
  if (!m.images || m.images.length === 0) return base;
  return {
    role: base.role,
    content: [
      ...(base.content ? [{ type: "text", text: base.content }] : []),
      ...m.images.map((url) => ({ type: "image_url", image_url: { url } })),
    ],
  };
}

/**
 * Ollama message with optional vision support: `/api/chat` takes raw base64
 * strings (no data-URL prefix) in an `images` array next to `content`.
 */
export function toOllamaMessage(m: ChatMessage): { role: string; content: string; images?: string[] } {
  const base = toProviderMessage(m);
  if (!m.images || m.images.length === 0) return base;
  const raw = m.images
    .map((url) => parseDataUrl(url)?.base64)
    .filter((b): b is string => !!b);
  return raw.length > 0 ? { ...base, images: raw } : base;
}

export function splitAnthropicMessages(messages: ChatMessage[]): {
  systemText: string | undefined;
  userMessages: { role: string; content: unknown }[];
} {
  const systemMsg = messages.find((m) => m.role === "system");
  const userMessages = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      const base = toProviderMessage(m);
      if (!m.images || m.images.length === 0) return base;
      const imageBlocks = m.images
        .map(parseDataUrl)
        .filter((p): p is { mediaType: string; base64: string } => !!p)
        .map((p) => ({
          type: "image",
          source: { type: "base64", media_type: p.mediaType, data: p.base64 },
        }));
      if (imageBlocks.length === 0) return base;
      return {
        role: base.role,
        content: [
          ...imageBlocks,
          ...(base.content ? [{ type: "text", text: base.content }] : []),
        ],
      };
    });
  return { systemText: systemMsg?.content, userMessages };
}

export function estimateTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) total += countTokens(m.content);
  return total;
}

export function estimateText(text: string): number {
  return countTokens(text);
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Strip a dangling `<tool_call>` opener (no matching closer) from the END of
 * streamed/returned text. Some models narrate their native tool call as prose
 * ("… <tool_call>") right before the server switches to structured tool-call
 * deltas (observed with MiniMax M3); appending our canonical
 * `<tool_call>{json}</tool_call>` tag after that leftover produces a doubled
 * opener that breaks the agent loop's parser and leaks raw tags into chat.
 */
function trimDanglingToolCallTag(content: string): string {
  return content.replace(/(?:\s*<tool_call>\s*)+$/, "");
}

/** True when the target is the bundled local engine (loopback address). */
function isLoopbackTarget(target: ModelTarget): boolean {
  try {
    const host = new URL(target.baseUrl).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Feral extension fields (`grammar`, `grammar_triggers`, `cache_prompt`)
 * are honored only by the bundled llama.cpp engine. They are sent ONLY to
 * loopback targets: strict cloud OpenAI-compatible servers (OpenAI itself,
 * NVIDIA NIM, …) reject unknown body parameters with a 400, which would
 * fail every agent request against them.
 */
function feralExtensionBody(
  target: ModelTarget,
  req: InferenceRequest,
): Record<string, unknown> {
  if (!isLoopbackTarget(target)) return {};
  return {
    ...(req.grammar
      ? {
          grammar: req.grammar,
          ...(req.grammarTriggers && req.grammarTriggers.length > 0
            ? { grammar_triggers: req.grammarTriggers }
            : {}),
        }
      : {}),
    ...(req.cachePrompt !== undefined ? { cache_prompt: req.cachePrompt } : {}),
  };
}
