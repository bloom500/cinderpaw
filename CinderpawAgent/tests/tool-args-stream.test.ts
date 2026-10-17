// Every provider reports a tool call's arguments while they stream, so the
// desktop can show a document being written instead of waiting for the end.
import { afterEach, describe, expect, it } from "bun:test";
import {
  AnthropicProvider,
  OllamaProvider,
  OpenAICompatibleProvider,
} from "../src/egress/inference-providers.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function serve(lines: string[]): void {
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          for (const l of lines) controller.enqueue(enc.encode(l));
          controller.close();
        },
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
}

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n`;

function request(calls: Array<[number, string, string]>) {
  return {
    sessionId: "s",
    messages: [{ role: "user" as const, content: "write it" }],
    onToken: () => {},
    onToolArgs: (call: number, name: string, args: string) => calls.push([call, name, args]),
  };
}

describe("onToolArgs", () => {
  it("OpenAI-compatible: reports the name, then every argument fragment as it grows", async () => {
    serve([
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "artifact_create" } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"title":"Pl' } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'an","content":"Hi"}' } }] } }] }),
      "data: [DONE]\n",
    ]);
    const calls: Array<[number, string, string]> = [];
    const res = await new OpenAICompatibleProvider().complete(
      { provider: "openai-compatible", model: "m", baseUrl: "https://api.example.com" },
      request(calls),
      false,
    );
    expect(calls).toEqual([
      [0, "artifact_create", ""],
      [0, "artifact_create", '{"title":"Pl'],
      [0, "artifact_create", '{"title":"Plan","content":"Hi"}'],
    ]);
    // Unchanged: the call still lands in content for parseResponse.
    expect(res.content).toContain('{"name":"artifact_create","args":{"title":"Plan","content":"Hi"}}');
  });

  it("Anthropic: reports the block when it starts, then each input_json_delta", async () => {
    serve([
      sse({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t", name: "artifact_create" } }),
      sse({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"content":"Hel' } }),
      sse({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'lo"}' } }),
      sse({ type: "content_block_stop", index: 1 }),
    ]);
    const calls: Array<[number, string, string]> = [];
    const res = await new AnthropicProvider().complete(
      { provider: "anthropic", model: "m", baseUrl: "https://api.example.com" },
      request(calls),
      false,
    );
    expect(calls).toEqual([
      [1, "artifact_create", ""],
      [1, "artifact_create", '{"content":"Hel'],
      [1, "artifact_create", '{"content":"Hello"}'],
    ]);
    expect(res.content).toContain('{"name":"artifact_create","args":{"content":"Hello"}}');
  });

  it("Ollama: reports arguments that arrive as one object", async () => {
    serve([
      JSON.stringify({
        message: { content: "", tool_calls: [{ function: { name: "artifact_create", arguments: { title: "T", content: "All of it" } } }] },
      }) + "\n",
      JSON.stringify({ done: true, prompt_eval_count: 1, eval_count: 1 }) + "\n",
    ]);
    const calls: Array<[number, string, string]> = [];
    await new OllamaProvider().complete(
      { provider: "ollama", model: "m", baseUrl: "http://127.0.0.1:11434" },
      request(calls),
      false,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toBe("artifact_create");
    expect(JSON.parse(calls[0]![2])).toEqual({ title: "T", content: "All of it" });
  });
});
