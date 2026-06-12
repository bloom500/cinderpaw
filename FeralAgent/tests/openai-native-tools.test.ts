import { describe, expect, it } from "bun:test";
import { buildOpenAITools, parseResponse } from "../src/core/agent-loop.ts";
import {
  stripToolsFromSystemPrompt,
  OpenAICompatibleProvider,
  OllamaProvider,
} from "../src/sandbox/inference-providers.ts";
import type { Tool, ToolRegistry } from "../src/types.ts";

describe("buildOpenAITools", () => {
  it("converts registry tools to OpenAI-compatible definitions", () => {
    const mockTools: Tool[] = [
      {
        manifest: {
          name: "web_search",
          description: "Search the web for a query",
          permissions: ["network:outbound"],
          networkAccess: true,
        },
        parameters: {
          query: {
            type: "string",
            description: "The search query",
            required: true,
          },
          limit: {
            type: "number",
            description: "Max results",
            required: false,
          },
        },
        execute: async () => ({ ok: true, output: "" }),
      },
    ];

    const mockRegistry = {
      list: () => mockTools,
    } as unknown as ToolRegistry;

    const openAITools = buildOpenAITools(mockRegistry);
    expect(openAITools).toHaveLength(1);
    expect(openAITools[0]).toEqual({
      type: "function",
      function: {
        name: "web_search",
        description: "Search the web for a query",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "The search query" },
            limit: { type: "number", description: "Max results" },
          },
          required: ["query"],
        },
      },
    });
  });
});

describe("stripToolsFromSystemPrompt", () => {
  it("removes available tools and how to call instructions but preserves rules", () => {
    const systemPrompt = [
      "## FeralAgent base (highest priority — always on)",
      "System guidelines here.",
      "",
      "You are Feral.",
      "---",
      "",
      "## Available tools",
      "web_search: Search the web.",
      "",
      "## How to call a tool",
      "Emit a fenced code block with the tag `tool`, containing a single JSON object:",
      "```tool",
      '{"name": "tool_name", "args": {}}',
      "```",
      "More description here.",
      "",
      "## Rules",
      "- Be concise.",
      "- Respond in the same language.",
    ].join("\n");

    const expected = [
      "## FeralAgent base (highest priority — always on)",
      "System guidelines here.",
      "",
      "You are Feral.",
      "---",
      "",
      "## Rules",
      "- Be concise.",
      "- Respond in the same language.",
    ].join("\n");

    const stripped = stripToolsFromSystemPrompt(systemPrompt);
    expect(stripped).toBe(expected);
  });

  it("handles No tools are available fallback line", () => {
    const systemPrompt = [
      "You are Feral.",
      "---",
      "",
      "No tools are available.",
      "",
      "## Rules",
      "- Be concise.",
    ].join("\n");

    const expected = [
      "You are Feral.",
      "---",
      "",
      "## Rules",
      "- Be concise.",
    ].join("\n");

    const stripped = stripToolsFromSystemPrompt(systemPrompt);
    expect(stripped).toBe(expected);
  });
});

describe("OpenAICompatibleProvider native function calling", () => {
  it("processes non-streaming native tool calls correctly", async () => {
    const provider = new OpenAICompatibleProvider();
    const mockRequest = {
      sessionId: "test-sess",
      messages: [{ role: "system" as const, content: "## Available tools\nRules here" }, { role: "user" as const, content: "hello" }],
      openAITools: [
        {
          type: "function" as const,
          function: {
            name: "web_search",
            description: "Search",
            parameters: { type: "object" as const, properties: {}, required: [] },
          },
        },
      ],
    };

    const originalFetch = globalThis.fetch;
    let requestBody: any = null;

    globalThis.fetch = (async (input: any, init: any) => {
      requestBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "I will call the search tool.",
                tool_calls: [
                  {
                    id: "call_123",
                    type: "function",
                    function: {
                      name: "web_search",
                      arguments: '{"query": "antigravity"}',
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    try {
      const res = await provider.complete(
        { provider: "openai-compatible", model: "gpt-4o", baseUrl: "https://api.openai.com" },
        mockRequest,
        false
      );

      expect(requestBody.tools).toEqual(mockRequest.openAITools);
      expect(requestBody.tool_choice).toBe("auto");
      expect(requestBody.messages[0].content).not.toContain("## Available tools");
      
      // Verify parsed output is formatted as <tool_call> XML
      expect(res.content).toContain("I will call the search tool.");
      expect(res.content).toContain("<tool_call>");
      expect(res.content).toContain('{"name":"web_search","args":{"query":"antigravity"}}');
      expect(res.content).toContain("</tool_call>");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("accumulates streaming native tool call chunks correctly", async () => {
    const provider = new OpenAICompatibleProvider();
    const tokensEmitted: string[] = [];
    const mockRequest = {
      sessionId: "test-sess",
      messages: [{ role: "system" as const, content: "## Available tools\nRules here" }, { role: "user" as const, content: "hello" }],
      openAITools: [
        {
          type: "function" as const,
          function: {
            name: "web_search",
            description: "Search",
            parameters: { type: "object" as const, properties: {}, required: [] },
          },
        },
      ],
      onToken: (tok: string) => {
        tokensEmitted.push(tok);
      },
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      // Return a stream with multiple data chunks
      const chunks = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Thinking..." } }] })}\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "web_search" } }] } }] })}\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"qu' } }] } }] })}\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ery": "antigravity"}' } }] } }] })}\n`,
        "data: [DONE]\n",
      ];
      
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });

      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    try {
      const res = await provider.complete(
        { provider: "openai-compatible", model: "gpt-4o", baseUrl: "https://api.openai.com" },
        mockRequest,
        false
      );

      // Verify that "Thinking..." token is streamed, but raw JSON parts are not.
      // Instead, a complete <tool_call> tag is emitted at the end.
      expect(tokensEmitted).toContain("Thinking...");
      expect(tokensEmitted.join("")).toContain("<tool_call>");
      expect(tokensEmitted.join("")).toContain('{"name":"web_search","args":{"query":"antigravity"}}');
      expect(tokensEmitted.join("")).toContain("</tool_call>");

      expect(res.content).toContain("Thinking...");
      expect(res.content).toContain("<tool_call>");
      expect(res.content).toContain('{"name":"web_search","args":{"query":"antigravity"}}');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("OllamaProvider native function calling", () => {
  it("processes non-streaming native tool calls correctly", async () => {
    const provider = new OllamaProvider();
    const mockRequest = {
      sessionId: "test-sess",
      messages: [{ role: "system" as const, content: "## Available tools\nRules here" }, { role: "user" as const, content: "hello" }],
      openAITools: [
        {
          type: "function" as const,
          function: {
            name: "web_search",
            description: "Search",
            parameters: { type: "object" as const, properties: {}, required: [] },
          },
        },
      ],
    };

    const originalFetch = globalThis.fetch;
    let requestBody: any = null;

    globalThis.fetch = (async (input: any, init: any) => {
      requestBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          message: {
            content: "Calling search.",
            tool_calls: [
              {
                function: {
                  name: "web_search",
                  arguments: { query: "antigravity" },
                },
              },
            ],
          },
          prompt_eval_count: 10,
          eval_count: 20,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    try {
      const res = await provider.complete(
        { provider: "ollama", model: "llama3", baseUrl: "http://localhost:11434" },
        mockRequest,
        false
      );

      expect(requestBody.tools).toEqual(mockRequest.openAITools);
      expect(requestBody.messages[0].content).not.toContain("## Available tools");

      expect(res.content).toContain("Calling search.");
      expect(res.content).toContain("<tool_call>");
      expect(res.content).toContain('{"name":"web_search","args":{"query":"antigravity"}}');
      expect(res.content).toContain("</tool_call>");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("accumulates streaming native tool call chunks correctly", async () => {
    const provider = new OllamaProvider();
    const tokensEmitted: string[] = [];
    const mockRequest = {
      sessionId: "test-sess",
      messages: [{ role: "system" as const, content: "## Available tools\nRules here" }, { role: "user" as const, content: "hello" }],
      openAITools: [
        {
          type: "function" as const,
          function: {
            name: "web_search",
            description: "Search",
            parameters: { type: "object" as const, properties: {}, required: [] },
          },
        },
      ],
      onToken: (tok: string) => {
        tokensEmitted.push(tok);
      },
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const chunks = [
        JSON.stringify({ message: { content: "Thinking..." }, done: false }) + "\n",
        JSON.stringify({ message: { tool_calls: [{ function: { name: "web_search", arguments: { query: "antigravity" } } }] }, done: false }) + "\n",
        JSON.stringify({ done: true, prompt_eval_count: 10, eval_count: 20 }) + "\n",
      ];

      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });

      return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson" } });
    }) as typeof fetch;

    try {
      const res = await provider.complete(
        { provider: "ollama", model: "llama3", baseUrl: "http://localhost:11434" },
        mockRequest,
        false
      );

      expect(tokensEmitted).toContain("Thinking...");
      expect(tokensEmitted.join("")).toContain("<tool_call>");
      expect(tokensEmitted.join("")).toContain('{"name":"web_search","args":{"query":"antigravity"}}');
      expect(tokensEmitted.join("")).toContain("</tool_call>");

      expect(res.content).toContain("Thinking...");
      expect(res.content).toContain("<tool_call>");
      expect(res.content).toContain('{"name":"web_search","args":{"query":"antigravity"}}');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("parseResponse tool_call tag robustness", () => {
  it("parses a clean <tool_call> tag", () => {
    const raw = 'Sure.\n<tool_call>\n{"name":"web_search","args":{"query":"x"}}\n</tool_call>';
    const parsed = parseResponse(raw);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0]!.name).toBe("web_search");
    expect(parsed.text).toBe("Sure.");
  });

  it("parses the call when the model left a dangling <tool_call> opener before the canonical tag (MiniMax M3 regression)", () => {
    // Model narrated "<tool_call>" as prose, then the provider appended the
    // canonical tag built from native tool-call deltas.
    const raw =
      "Am gasit! Hai sa extrag detaliile. <tool_call>\n" +
      '<tool_call>\n{"name":"read_webpage","args":{"url":"https://example.com/a"}}\n</tool_call>';
    const parsed = parseResponse(raw);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0]!.name).toBe("read_webpage");
    expect(parsed.toolCalls[0]!.args).toEqual({ url: "https://example.com/a" });
    // No raw tags may leak into the visible text.
    expect(parsed.text).not.toContain("<tool_call>");
    expect(parsed.text).not.toContain("</tool_call>");
    expect(parsed.text).toContain("Am gasit!");
  });

  it("strips orphan tool_call tags from a no-call answer", () => {
    const parsed = parseResponse("Here you go. <tool_call>");
    expect(parsed.toolCalls).toHaveLength(0);
    expect(parsed.text).toBe("Here you go.");
  });
});

describe("parseResponse bare tool-call JSON (chat leak regression)", () => {
  // Observed in production: MiniMax M3 emitted parallel memory_ops calls as
  // bare JSON in the content — no <tool_call> tags — and the raw JSON was
  // displayed to the user instead of executing.

  it("parses a single bare tool-call JSON object", () => {
    const raw = '{"name":"memory_ops","args":{"action":"forget","key":"workspace_path"}}';
    const parsed = parseResponse(raw);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0]!.name).toBe("memory_ops");
    expect(parsed.toolCalls[0]!.args).toEqual({ action: "forget", key: "workspace_path" });
    expect(parsed.text).toBe("");
  });

  it("parses multiple concatenated bare calls on one line", () => {
    const raw =
      '{"name":"memory_ops","args":{"action":"forget","key":"a"}} ' +
      '{"name":"memory_ops","args":{"action":"forget","key":"b"}}';
    const parsed = parseResponse(raw);
    expect(parsed.toolCalls).toHaveLength(2);
    expect(parsed.text).toBe("");
  });

  it("hides corrupted tool-call-shaped JSON instead of displaying it", () => {
    // The actual corruption seen in chat: {"name="memory_ops"> …
    const raw =
      'Am sters intrarile. {"name="memory_ops">{"action":"forget","key":"- project"}';
    const parsed = parseResponse(raw);
    expect(parsed.text).toContain("Am sters intrarile.");
    expect(parsed.text).not.toContain("memory_ops");
    expect(parsed.text).not.toContain('{"name=');
  });

  it("leaves tool-call JSON inside code fences untouched (documentation case)", () => {
    const raw =
      'Formatul este:\n```json\n{"name":"web_search","args":{"query":"x"}}\n```\nAtat.';
    const parsed = parseResponse(raw);
    expect(parsed.toolCalls).toHaveLength(0);
    expect(parsed.text).toContain('{"name":"web_search"');
  });

  it("leaves non-tool-shaped JSON in prose untouched", () => {
    const raw = 'Config-ul arata asa: {"port": 8080, "host": "localhost"} — ok?';
    const parsed = parseResponse(raw);
    expect(parsed.toolCalls).toHaveLength(0);
    expect(parsed.text).toBe(raw);
  });

  it("mixes prose and a bare call: keeps prose, executes call", () => {
    const raw = 'Sterg acum.\n{"name":"memory_ops","args":{"action":"forget","key":"x"}}';
    const parsed = parseResponse(raw);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.text).toBe("Sterg acum.");
  });
});
