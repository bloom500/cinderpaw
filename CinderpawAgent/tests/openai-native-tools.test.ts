import { describe, expect, it } from "bun:test";
import { buildOpenAITools, parseResponse } from "../src/core/agent-loop.ts";
import {
  stripToolsFromSystemPrompt,
  OpenAICompatibleProvider,
  OllamaProvider,
} from "../src/egress/inference-providers.ts";
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
      "## CinderpawAgent base (highest priority — always on)",
      "System guidelines here.",
      "",
      "You are Cinderpaw.",
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
      "## CinderpawAgent base (highest priority — always on)",
      "System guidelines here.",
      "",
      "You are Cinderpaw.",
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
      "You are Cinderpaw.",
      "---",
      "",
      "No tools are available.",
      "",
      "## Rules",
      "- Be concise.",
    ].join("\n");

    const expected = [
      "You are Cinderpaw.",
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

      // Verify that "Thinking..." token is streamed, but the tool call never
      // reaches the token stream — chunk events go to the chat UI verbatim,
      // so a raw <tool_call> tag after prose would leak into the visible
      // answer. The tag lives in `content` only, where parseResponse reads it.
      expect(tokensEmitted).toContain("Thinking...");
      expect(tokensEmitted.join("")).not.toContain("<tool_call>");

      expect(res.content).toContain("Thinking...");
      expect(res.content).toContain("<tool_call>");
      expect(res.content).toContain('{"name":"web_search","args":{"query":"antigravity"}}');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Walk-away bench, 2026-07-25: a batch of parallel calls executed as ONE.
  // Three lead POSTs became one; "pause + raise budget" only paused; "GET then
  // POST" dropped the GET and wrote a record it had never checked for. All of
  // it was `tc.index ?? 0` collapsing an index-less batch into a single slot,
  // where names overwrote each other and argument fragments concatenated.
  it("keeps parallel tool calls apart when the provider omits index", async () => {
    const provider = new OpenAICompatibleProvider();
    const mockRequest = {
      sessionId: "test-sess",
      messages: [{ role: "user" as const, content: "import the leads" }],
      openAITools: [
        {
          type: "function" as const,
          function: {
            name: "http_request",
            description: "HTTP",
            parameters: { type: "object" as const, properties: {}, required: [] },
          },
        },
      ],
      onToken: () => {},
    };

    const originalFetch = globalThis.fetch;
    const delta = (tc: unknown) =>
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [tc] } }] })}\n`;
    globalThis.fetch = (async () => {
      const chunks = [
        // No `index` anywhere — the shape that broke. Arguments arrive split,
        // so the continuation fragments must land on the call they follow.
        delta({ id: "c1", type: "function", function: { name: "http_request" } }),
        delta({ function: { arguments: '{"url":' } }),
        delta({ function: { arguments: '"/a"}' } }),
        delta({ id: "c2", type: "function", function: { name: "http_request" } }),
        delta({ function: { arguments: '{"url":"/b"}' } }),
        delta({ id: "c3", type: "function", function: { name: "http_request" } }),
        delta({ function: { arguments: '{"url":"/c"}' } }),
        "data: [DONE]\n",
      ];
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      const res = await provider.complete(
        { provider: "openai-compatible", model: "m", baseUrl: "https://api.example.com" },
        mockRequest,
        false,
      );
      // All three survive, each with its OWN url — not one merged survivor.
      expect(res.content).toContain('{"name":"http_request","args":{"url":"/a"}}');
      expect(res.content).toContain('{"name":"http_request","args":{"url":"/b"}}');
      expect(res.content).toContain('{"name":"http_request","args":{"url":"/c"}}');
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

      // Tool calls must never reach the token stream (they'd leak into the
      // chat UI after prose); they are appended to `content` only.
      expect(tokensEmitted).toContain("Thinking...");
      expect(tokensEmitted.join("")).not.toContain("<tool_call>");

      expect(res.content).toContain("Thinking...");
      expect(res.content).toContain("<tool_call>");
      expect(res.content).toContain('{"name":"web_search","args":{"query":"antigravity"}}');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("parallel native tool calls", () => {
  it("re-encodes ALL non-streaming tool calls, not just the first", async () => {
    const provider = new OpenAICompatibleProvider();
    const mockRequest = {
      sessionId: "test-sess",
      messages: [{ role: "user" as const, content: "hello" }],
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
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  { id: "c1", type: "function", function: { name: "web_search", arguments: '{"query": "a"}' } },
                  { id: "c2", type: "function", function: { name: "web_search", arguments: '{"query": "b"}' } },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    try {
      const res = await provider.complete(
        { provider: "openai-compatible", model: "gpt-4o", baseUrl: "https://api.openai.com" },
        mockRequest,
        false,
      );
      expect(res.content).toContain('{"name":"web_search","args":{"query":"a"}}');
      expect(res.content).toContain('{"name":"web_search","args":{"query":"b"}}');
      // Both calls must survive a round-trip through the loop's parser.
      const parsed = parseResponse(res.content);
      expect(parsed.toolCalls).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("buildOpenAITools schema pass-through", () => {
  it("uses the full JSON Schema when a parameter declares one", () => {
    const itemsSchema = {
      type: "array",
      items: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
    };
    const mockTools: Tool[] = [
      {
        manifest: { name: "ask_user", description: "Ask", permissions: [], networkAccess: false },
        parameters: {
          questions: { type: "array", description: "questions", required: true, schema: itemsSchema },
        },
        execute: async () => ({ ok: true, content: "" }),
      } as unknown as Tool,
    ];
    const mockRegistry = { list: () => mockTools } as unknown as ToolRegistry;
    const defs = buildOpenAITools(mockRegistry);
    expect(defs[0]!.function.parameters.properties.questions).toEqual(itemsSchema);
  });
});

describe("parseResponse malformed tool-call detection", () => {
  it("flags a corrupted bare tool-call object and scrubs it from text", () => {
    const parsed = parseResponse('Let me check.\n{"name="memory_graph">');
    expect(parsed.toolCalls).toHaveLength(0);
    expect(parsed.malformedToolCall).toBe(true);
    expect(parsed.text).not.toContain("memory_graph");
  });

  it("flags a dangling <tool_call> opener with no valid JSON", () => {
    const parsed = parseResponse("Working on it.\n<tool_call>");
    expect(parsed.toolCalls).toHaveLength(0);
    expect(parsed.malformedToolCall).toBe(true);
  });

  it("does not flag plain prose or valid calls", () => {
    expect(parseResponse("All done, here is the answer.").malformedToolCall).toBe(false);
    const valid = parseResponse('<tool_call>{"name":"web_search","args":{}}</tool_call>');
    expect(valid.toolCalls).toHaveLength(1);
    expect(valid.malformedToolCall).toBe(false);
  });

  it('flags the JSON/XML hybrid {"invoke name="tool"> and scrubs it', () => {
    // Observed in the wild (2026-06-13 session): the model imitated
    // Anthropic-style invoke XML with a brace. Previously escaped detection
    // (first key is "invoke", not name/tool) and ended the turn mid-task.
    const parsed = parseResponse(
      'Să vedem ce spațiu am la dispoziție. {"invoke name="write_file">',
    );
    expect(parsed.toolCalls).toHaveLength(0);
    expect(parsed.malformedToolCall).toBe(true);
    expect(parsed.text).not.toContain("invoke");
    expect(parsed.text).toContain("Să vedem ce spațiu am la dispoziție.");
  });

  it("reads a namespaced invoke with parameter tags — the real Anthropic shape", () => {
    // Verbatim from the 8h endurance run's first turn, 2026-08-11. Thirty-one
    // tool calls in our own syntax, then the last message came out in this one
    // and was delivered to the user as the answer: raw markup, task abandoned.
    //
    // Two things defeated the parser at once. The tag carries a namespace
    // prefix (`atem:`, the model imitating `antml:`) and the matcher anchored
    // on a bare `<invoke`. And the arguments arrive as `<parameter name="x">`,
    // which is what Anthropic's format actually looks like — the parser only
    // ever handled the simplified `<x>value</x>` variant while its docstring
    // claimed the format by name.
    const raw =
      "<atem:function_calls>\n" +
      '<atem:invoke name="shell_exec">\n' +
      '<atem:parameter name="argv">["cmd","/c","node check.mjs"]</atem:parameter>\n' +
      "</atem:invoke>\n" +
      "</atem:function_calls>";
    const parsed = parseResponse(raw);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0]!.name).toBe("shell_exec");
    expect(parsed.toolCalls[0]!.args).toEqual({ argv: ["cmd", "/c", "node check.mjs"] });
    // And none of the markup survives into what the person reads.
    expect(parsed.text).not.toContain("invoke");
  });

  it("an unclosed invoke does not swallow the call that follows it", () => {
    // The model forgot one `</invoke>`. The old matcher ran to end-of-message,
    // so the second call lived inside the first one's body and never ran — a
    // turn that asked for two tools silently did one.
    const raw =
      '<invoke name="time_date">\n<parameter name="tz">UTC</parameter>\n' +
      '<invoke name="self_health">\n<parameter name="scope">all</parameter>\n</invoke>';
    const parsed = parseResponse(raw);
    expect(parsed.toolCalls.map((c) => c.name)).toEqual(["time_date", "self_health"]);
  });

  it("reads the same shape without a namespace", () => {
    const raw =
      '<invoke name="write_file">\n' +
      '<parameter name="path">notes.md</parameter>\n' +
      '<parameter name="content">hello</parameter>\n' +
      "</invoke>";
    const parsed = parseResponse(raw);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0]!.args).toEqual({ path: "notes.md", content: "hello" });
  });

  it('flags XML-style <invoke name="tool"> and scrubs it', () => {
    const parsed = parseResponse('Trying another way.\n<invoke name="write_file">');
    expect(parsed.toolCalls).toHaveLength(0);
    expect(parsed.malformedToolCall).toBe(true);
    expect(parsed.text).not.toContain("<invoke");
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

  // Walk-away bench, 2026-07-26: the ads-triage task failed intermittently with
  // "did not raise retargeting's budget" while the model insisted "Both calls
  // succeeded." It batches parallel calls by STACKING objects in one block
  // instead of opening a second tag, and we kept only the first — with
  // droppedToolCalls at 0, so nothing ever told the model.
  it("parses every stacked JSON object inside ONE <tool_call> block", () => {
    const raw =
      "Pausing the loser and raising the winner.\n<tool_call>\n" +
      '{"name":"http_request","args":{"method":"POST","url":"http://x/campaigns/summer_sale/pause"}}\n' +
      '{"name":"http_request","args":{"method":"POST","url":"http://x/campaigns/retargeting/budget","json":{"daily_budget":90}}}\n' +
      "</tool_call>";
    const parsed = parseResponse(raw);
    expect(parsed.toolCalls).toHaveLength(2);
    expect(parsed.toolCalls[1]!.args).toEqual({
      method: "POST",
      url: "http://x/campaigns/retargeting/budget",
      json: { daily_budget: 90 },
    });
    expect(parsed.droppedToolCalls).toBe(0);
  });

  it("counts a malformed sibling as dropped instead of losing it in silence", () => {
    const raw =
      "<tool_call>\n" +
      '{"name":"http_request","args":{"url":"http://x/a"}}\n' +
      '{"name":"http_request","args":{"url":\n' +
      "</tool_call>";
    const parsed = parseResponse(raw);
    expect(parsed.toolCalls).toHaveLength(1);
    // The half-call must be reported, or the model reads one result as two.
    expect(parsed.droppedToolCalls).toBe(1);
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

  it("executes a tool call wrapped in a ```json fence (MiniMax M3 shape)", () => {
    // Cloud models sometimes fence their call instead of using native
    // tool-calling. Skipping fenced content silently dropped these calls —
    // the turn ended with the JSON as the visible answer and nothing ran.
    // Tradeoff: a model that *documents* the format in a fence now triggers a
    // real call; in an agentic loop that's a recoverable extra call, far
    // cheaper than core tool-calling being silently broken.
    const raw =
      'Caut acum:\n```json\n{"name":"web_search","args":{"query":"x"}}\n```\nRevin imediat.';
    const parsed = parseResponse(raw);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0]!.name).toBe("web_search");
    expect(parsed.text).not.toContain('{"name":"web_search"');
  });

  it("leaves a non-tool-shaped JSON fence untouched (real code block)", () => {
    const raw =
      'Config-ul:\n```json\n{"port":8080,"host":"localhost"}\n```\nGata.';
    const parsed = parseResponse(raw);
    expect(parsed.toolCalls).toHaveLength(0);
    expect(parsed.text).toContain('{"port":8080');
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
