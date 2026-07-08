// Reasoning-fix contract tests for `OllamaProvider` (Open 1 of the
// "TUI agent chat UX" Polish, 2026-07-07).
//
// Background (see `docs/agents-memory/project_chat_tui.md` §Open
// question — reasoning for local Ollama models):
//
//   Local Ollama reasoning-capable models (qwen3, deepseek-r1,
//   MiniMax-M3 in thinking mode, …) stream chain-of-thought via a
//   separate `message.thinking` field. The cloud path folds that into
//   open-close tag pairs so the TUI's live thinking-splitter can
//   render reasoning separately from the answer. The local Ollama
//   path missed that wiring — every chain-of-thought token reached
//   the chat transcript as if it were the final answer.
//
// Tests below pin the contract the TUI relies on. Tags are written
// here as ASCII concatenation (the literal HTML-style tag characters
// pasted into a chat gateway get mangled by some terminals / markdown
// pipelines; building the strings programmatically avoids that
// entirely without affecting what the file actually says to the
// reader).
//
// The TUI is rendering-only; it never inspects the model name. These
// tests assert at the sidecar boundary (where wire → text happens)
// because that's the single seam both `feral-tui` (SSE delta frames)
// and the agent loop (stripThinking on the final completion) read
// from.

import { afterEach, describe, expect, it } from "bun:test";

import { OllamaProvider } from "../src/sandbox/inference-providers.ts";
import type {
  InferenceRequest,
  ModelTarget,
} from "../src/types.ts";

// Tag constants — built from individual char codes so the test source
// stays ASCII-clean (match what `.envrc` does for wire protocols
// compiled through other shells). The shape mirrors the production
// surface; what matters here is the contract, not the literal bytes.
const LT = "<";
const GT = ">";
const THINK_TAG = LT + "think" + GT;          // ["L","T","think","GT"]
const THINK_END = LT + "/" + "think" + GT;    // ["L","T","/","think","GT"]

const TARGET: ModelTarget = {
  provider: "ollama",
  model: "qwen3",
  baseUrl: "http://localhost:11434",
};

const REQ: Omit<InferenceRequest, "onToken"> & {
  onToken?: InferenceRequest["onToken"];
} = {
  messages: [{ role: "user", content: "hi" }],
  temperature: 0.7,
};

// Build a streaming Response whose body emits the given NDJSON lines
// one-by-one, with a synthetic newline terminator. Matches what the
// Ollama /api/chat `stream:true` endpoint actually sends.
function streamResponse(lines: Array<Record<string, unknown>>): Response {
  const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

let originalFetch: typeof fetch | null = null;
afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = null;
  }
});

describe("OllamaProvider — local reasoning splits into the TUI tag pair (Open 1 UX polish)", () => {
  it("non-stream: message.thinking is wrapped inside the tag pair before the answer", async () => {
    const provider = new OllamaProvider();
    originalFetch = globalThis.fetch;
    let seen: { url: string; body: any } | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : (input as Request).url;
      seen = {
        url,
        body: JSON.parse(init?.body as string),
      };
      return new Response(
        JSON.stringify({
          model: "qwen3",
          message: {
            role: "assistant",
            thinking: "Let me reason step by step.\n1. think\n2. answer",
            content: "Hello!",
          },
          prompt_eval_count: 5,
          eval_count: 7,
          done: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const res = await provider.complete(
      TARGET,
      { ...REQ, onToken: undefined },
      false,
    );

    // Sentinel + ordering kept the same way the cloud path produces.
    const expected =
      THINK_TAG +
      "Let me reason step by step.\n1. think\n2. answer" +
      THINK_END +
      "Hello!";
    expect(res.content).toBe(expected);
    expect(seen?.url).toBe("http://localhost:11434/api/chat");
    expect(seen?.body.stream).toBe(false);
  });

  it("non-stream: no thinking field leaves content unchanged", async () => {
    const provider = new OllamaProvider();
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          model: "qwen3",
          message: { role: "assistant", content: "Just an answer" },
          prompt_eval_count: 3,
          eval_count: 4,
          done: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    const res = await provider.complete(
      TARGET,
      { ...REQ, onToken: undefined },
      false,
    );

    expect(res.content).toBe("Just an answer");
  });

  it("stream: thinking chunks open the tag, content chunks close it (no per-model name check)", async () => {
    const provider = new OllamaProvider();
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> =>
      streamResponse([
        { message: { thinking: "step1 " }, done: false },
        { message: { thinking: "step2" }, done: false },
        { message: { content: "Hi" }, done: false },
        { message: { content: " there" }, done: false },
        {
          message: { role: "assistant" },
          prompt_eval_count: 5,
          eval_count: 9,
          done: true,
        },
      ])) as typeof fetch;

    const captured: string[] = [];
    const res = await provider.complete(
      TARGET,
      { ...REQ, onToken: (t) => captured.push(t) },
      false,
    );

    // Expect the TUI-shape streaming sequence: opener, thinking chunks
    // concatenated, closer BEFORE the first content token, then answer.
    const expected = THINK_TAG + "step1 step2" + THINK_END + "Hi there";
    expect(captured.join("")).toBe(expected);
    // And the returned completion mirrors onToken, so stripThinking()
    // has a well-formed block to strip.
    expect(res.content).toBe(expected);
  });

  it("stream: end-of-stream close — all-reasoning turn is well-formed for stripThinking", async () => {
    const provider = new OllamaProvider();
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> =>
      streamResponse([
        { message: { thinking: "only reasoning, " }, done: false },
        { message: { thinking: "no answer" }, done: false },
        {
          message: { role: "assistant" },
          prompt_eval_count: 1,
          eval_count: 6,
          done: true,
        },
      ])) as typeof fetch;

    const captured: string[] = [];
    const res = await provider.complete(
      TARGET,
      { ...REQ, onToken: (t) => captured.push(t) },
      false,
    );

    // Without close-on-end-of-stream, the live transcript would carry
    // an unclosed opener — stripThinking() drops everything after the
    // dangling open (existing semantics; same as cloud path).
    const expected = THINK_TAG + "only reasoning, no answer" + THINK_END;
    expect(captured.join("")).toBe(expected);
    expect(res.content).toBe(expected);
  });

  it("stream: thinking + content arriving in same chunk still emit a well-formed block", async () => {
    const provider = new OllamaProvider();
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> =>
      streamResponse([
        // The two fields coexisting on a single NDJSON chunk used to
        // confuse the cloud emitter too; verify the local mirror passes
        // the same case.
        { message: { thinking: "step", content: "ping" }, done: false },
        {
          message: { role: "assistant" },
          prompt_eval_count: 1,
          eval_count: 4,
          done: true,
        },
      ])) as typeof fetch;

    const captured: string[] = [];
    await provider.complete(
      TARGET,
      { ...REQ, onToken: (t) => captured.push(t) },
      false,
    );

    const expected = THINK_TAG + "step" + THINK_END + "ping";
    expect(captured.join("")).toBe(expected);
  });

  it("stream: content-only prompts (no thinking field) stream unchanged", async () => {
    // The first non-thinking run on a model that supports thinking must
    // not have a phantom opener inserted. Catches the regression where
    // the opener got emitted speculatively.
    const provider = new OllamaProvider();
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> =>
      streamResponse([
        { message: { content: "Just " }, done: false },
        { message: { content: "hi" }, done: false },
        {
          message: { role: "assistant" },
          prompt_eval_count: 1,
          eval_count: 4,
          done: true,
        },
      ])) as typeof fetch;

    const captured: string[] = [];
    await provider.complete(
      TARGET,
      { ...REQ, onToken: (t) => captured.push(t) },
      false,
    );

    expect(captured.join("")).toBe("Just hi");
    // No thinking tag anywhere in the stream.
    expect(captured.join("")).not.toContain(THINK_TAG);
    expect(captured.join("")).not.toContain(THINK_END);
  });
});
