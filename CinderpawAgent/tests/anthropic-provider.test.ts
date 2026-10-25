import { afterEach, describe, expect, test } from "bun:test";
import { AnthropicProvider, anthropicEffort, anthropicMaxTokens, anthropicSampling, openAIReasoning } from "../src/egress/inference-providers";
import type { InferenceRequest, ModelTarget } from "../src/types";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const target = (model: string, apiKey = `sk-ant-${model}-${Math.random()}`): ModelTarget =>
  ({ provider: "anthropic", model, baseUrl: "https://api.anthropic.com", apiKey });
const req = { messages: [{ role: "user", content: "Hi" }] } as unknown as InferenceRequest;

describe("anthropicSampling", () => {
  test("older Claude models still get a temperature", () => {
    for (const m of ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6", "claude-sonnet-4-5-20250929",
      "claude-opus-4-1-20250805", "claude-sonnet-4-20250514", "claude-3-5-haiku-20241022", "claude-2.1",
      "claude-instant-1.2"]) {
      expect(anthropicSampling(target(m), req)).toEqual({ temperature: 0.7 });
    }
  });

  test("current and unknown models get none, since they refuse it with a 400", () => {
    for (const m of ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5",
      "claude-opus-4-7", "claude-opus-4-8", "claude-fable-5-1", "claude-something-next", "claude-5-5", "claude-4"]) {
      expect(anthropicSampling(target(m), req)).toEqual({});
    }
  });
});

describe("reasoning effort reaches only an API that takes it", () => {
  const withEffort = { ...req, reasoningEffort: "low" } as InferenceRequest;

  test("Claude models with an effort setting get output_config.effort", () => {
    for (const m of ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5",
      "claude-fable-5-1", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-4-5"]) {
      expect(anthropicEffort(target(m), withEffort)).toEqual({ output_config: { effort: "low" } });
    }
  });

  test("older and unknown Claude models get none, since effort is a 400 there", () => {
    for (const m of ["claude-haiku-4-5", "claude-sonnet-4-5-20250929", "claude-opus-4-1-20250805",
      "claude-3-5-haiku-20241022", "claude-something-next"]) {
      expect(anthropicEffort(target(m), withEffort)).toEqual({});
    }
  });

  test("no effort asked, nothing sent", () => {
    expect(anthropicEffort(target("claude-haiku-5-5"), req)).toEqual({});
  });

  test("the OpenAI-shaped reasoning field goes to OpenRouter and local servers only", () => {
    const t = (baseUrl: string): ModelTarget => ({ provider: "openai", model: "m", baseUrl, apiKey: "k" });
    expect(openAIReasoning(t("https://openrouter.ai/api/v1"), withEffort)).toEqual({ reasoning: { effort: "low" } });
    expect(openAIReasoning(t("http://127.0.0.1:11435/v1"), withEffort)).toEqual({ reasoning: { effort: "low" } });
    // OpenAI itself refuses an unknown `reasoning` argument with a 400, and a
    // champion carrying an effort would have broken every chat on it.
    expect(openAIReasoning(t("https://api.openai.com/v1"), withEffort)).toEqual({});
    expect(openAIReasoning(t("https://api.groq.com/openai/v1"), withEffort)).toEqual({});
    const capped = { ...req, reasoningMaxTokens: 512 } as InferenceRequest;
    expect(openAIReasoning(t("https://openrouter.ai/api/v1"), capped)).toEqual({ reasoning: { max_tokens: 512 } });
  });
});

describe("a key that must name its workspace", () => {
  const NEEDS_WORKSPACE = JSON.stringify({ type: "error", error: { type: "invalid_request_error",
    message: "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace" } });

  test("finds the Default Workspace once and sends the request again with it", async () => {
    const seen: { url: string; headers: Record<string, string>; body?: Record<string, unknown> }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      seen.push({ url, headers, body: init.body ? JSON.parse(init.body as string) : undefined });
      if (url.includes("/v1/organizations/workspaces")) {
        return Response.json({ data: [{ id: "wrkspc_cc", name: "Claude Code" }, { id: "wrkspc_default", name: "Default" }] });
      }
      if (!headers["anthropic-workspace-id"]) return new Response(NEEDS_WORKSPACE, { status: 400 });
      return Response.json({ content: [{ type: "text", text: "Hello!" }], usage: { input_tokens: 3, output_tokens: 2 } });
    }) as typeof fetch;

    const t = target("claude-haiku-5-5");
    const first = await new AnthropicProvider().complete(t, req, false);
    expect(first.content).toBe("Hello!");
    expect(seen.map((s) => s.url.replace("https://api.anthropic.com", ""))).toEqual([
      "/v1/messages", "/v1/organizations/workspaces?include_default=true&limit=1000", "/v1/messages"]);
    expect(seen[2]!.headers["anthropic-workspace-id"]).toBe("wrkspc_default");
    expect(seen[2]!.body).not.toHaveProperty("temperature");

    // Remembered: the next request names the workspace straight away.
    await new AnthropicProvider().complete(t, req, false);
    expect(seen).toHaveLength(4);
    expect(seen[3]!.headers["anthropic-workspace-id"]).toBe("wrkspc_default");
  });

  test("reads every page of workspaces before picking, so a Default on page two still wins", async () => {
    const lookups: string[] = [];
    let used = "";
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      if (url.includes("/v1/organizations/workspaces")) {
        lookups.push(url);
        return url.includes("after_id=wrkspc_a")
          ? Response.json({ data: [{ id: "wrkspc_default", name: "Default" }], has_more: false, last_id: "wrkspc_default" })
          : Response.json({ data: [{ id: "wrkspc_a", name: "Alpha" }], has_more: true, last_id: "wrkspc_a" });
      }
      used = (init.headers as Record<string, string>)["anthropic-workspace-id"] ?? "";
      return used ? Response.json({ content: [{ type: "text", text: "ok" }] }) : new Response(NEEDS_WORKSPACE, { status: 400 });
    }) as typeof fetch;

    await new AnthropicProvider().complete(target("claude-haiku-5-5"), req, false);
    expect(lookups).toHaveLength(2);
    expect(lookups[0]).toContain("limit=1000");
    expect(used).toBe("wrkspc_default");
  });

  test("a later page that fails ends the lookup instead of picking from half the list", async () => {
    let messages = 0;
    globalThis.fetch = (async (url: string) => {
      if (url.includes("/v1/organizations/workspaces")) {
        return url.includes("after_id=")
          ? new Response("{}", { status: 500 })
          : Response.json({ data: [{ id: "wrkspc_a", name: "Alpha" }], has_more: true, last_id: "wrkspc_a" });
      }
      messages++;
      return new Response(NEEDS_WORKSPACE, { status: 400 });
    }) as typeof fetch;

    await expect(new AnthropicProvider().complete(target("claude-haiku-5-5"), req, false)).rejects.toThrow(/more than one workspace/);
    expect(messages).toBe(1);
  });

  test("a cursor that does not move ends the lookup instead of asking forever", async () => {
    let lookups = 0;
    globalThis.fetch = (async (url: string) => {
      if (url.includes("/v1/organizations/workspaces")) {
        lookups++;
        return Response.json({ data: [{ id: "wrkspc_a", name: "Alpha" }], has_more: true, last_id: "wrkspc_a" });
      }
      return new Response(NEEDS_WORKSPACE, { status: 400 });
    }) as typeof fetch;

    await expect(new AnthropicProvider().complete(target("claude-haiku-5-5"), req, false)).rejects.toThrow(/more than one workspace/);
    expect(lookups).toBe(2);
  });

  test("a chat cancelled during the lookup stops there and is not sent again", async () => {
    const abort = new AbortController();
    let messages = 0;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      if (url.includes("/v1/organizations/workspaces")) {
        abort.abort();
        if (init.signal?.aborted) throw init.signal.reason;
        return Response.json({ data: [{ id: "wrkspc_default", name: "Default" }] });
      }
      messages++;
      return new Response(NEEDS_WORKSPACE, { status: 400 });
    }) as typeof fetch;

    await expect(new AnthropicProvider().complete(target("claude-haiku-5-5"), { ...req, signal: abort.signal }, false)).rejects.toThrow();
    expect(messages).toBe(1);
  });

  test("when the workspace cannot be found, the person reads what to do", async () => {
    globalThis.fetch = (async (url: string) =>
      url.includes("/v1/organizations/workspaces")
        ? new Response("{}", { status: 403 })
        : new Response(NEEDS_WORKSPACE, { status: 400 })) as typeof fetch;

    await expect(new AnthropicProvider().complete(target("claude-haiku-5-5"), req, false))
      .rejects.toThrow(/more than one workspace.*platform\.claude\.com\/settings\/keys/);
  });

  test("any other 400 is passed on untouched, with no workspace lookup", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: "max_tokens: too large" } }), { status: 400 });
    }) as typeof fetch;

    await expect(new AnthropicProvider().complete(target("claude-haiku-4-5"), req, false)).rejects.toThrow(/max_tokens/);
    expect(calls).toBe(1);
  });
});

// 23 Oct: a whole PDF table appeared in one burst after 3.5 s of an empty panel.
// Without this field Anthropic buffers a tool's input and sends it at the end,
// so live writing (which draws the tool's arguments as they arrive) had nothing to draw.
describe("streamed tool input", () => {
  test("every tool asks Anthropic to stream its input as it is written", async () => {
    let body: { tools?: Record<string, unknown>[] } = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response("{}", { status: 400 });
    }) as typeof fetch;
    const tool = { name: "artifact_create", description: "d", input_schema: { type: "object", properties: {} } };
    const streaming = { ...req, onToken: () => {}, nativeTools: [tool] } as unknown as InferenceRequest;
    await new AnthropicProvider().complete(target("claude-haiku-5-5"), streaming, false).catch(() => {});
    expect(body.tools).toEqual([{ ...tool, eager_input_streaming: true }]);
  });
});

// 24 Oct: every other provider drops the prose tool list when native tools go
// out; Anthropic sent both, ~37k extra tokens on a "hello".
describe("one copy of the tools", () => {
  const system = "You are Cinderpaw.\n\n## Available tools\nartifact_create: {...}\n\n## Rules\n- Be concise.";
  const withSystem = (extra: Record<string, unknown>) => ({
    ...req,
    messages: [{ role: "system", content: system }, { role: "user", content: "Hi" }],
    ...extra,
  }) as unknown as InferenceRequest;
  const tool = { name: "artifact_create", description: "d", input_schema: { type: "object", properties: {} } };

  for (const [name, extra] of [["streaming", { onToken: () => {} }], ["non-streaming", {}]] as const) {
    test(`${name}: native tools strip the prose list, the rest of the prompt stays`, async () => {
      let body: { system?: unknown } = {};
      globalThis.fetch = (async (_url: string, init: RequestInit) => {
        body = JSON.parse(init.body as string);
        return new Response("{}", { status: 400 });
      }) as typeof fetch;
      await new AnthropicProvider().complete(target("claude-haiku-5-5"), withSystem({ ...extra, nativeTools: [tool] }), false).catch(() => {});
      const sent = JSON.stringify(body.system);
      expect(sent).not.toContain("## Available tools");
      expect(sent).toContain("## Rules");
    });
  }

  test("without native tools the prose list is the only copy, so it stays", async () => {
    let body: { system?: unknown } = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response("{}", { status: 400 });
    }) as typeof fetch;
    await new AnthropicProvider().complete(target("claude-haiku-5-5"), withSystem({}), false).catch(() => {});
    expect(JSON.stringify(body.system)).toContain("## Available tools");
  });
});

// 24 Oct: two chats 25 s apart each wrote ~38k tokens and read 0, because the
// only breakpoint sat after a system prompt whose memory differs per chat.
describe("tools cached on their own", () => {
  const tool = (name: string) => ({ name, description: "d", input_schema: { type: "object", properties: {} } });
  for (const [name, extra] of [["streaming", { onToken: () => {} }], ["non-streaming", {}]] as const) {
    test(`${name}: the last tool carries the same breakpoint as the request`, async () => {
      let body: { tools?: Record<string, unknown>[]; cache_control?: unknown } = {};
      globalThis.fetch = (async (_url: string, init: RequestInit) => {
        body = JSON.parse(init.body as string);
        return new Response("{}", { status: 400 });
      }) as typeof fetch;
      const tools = [tool("a"), tool("b")];
      const r = { ...req, ...extra, nativeTools: tools, cachePrefix: "short" } as unknown as InferenceRequest;
      await new AnthropicProvider().complete(target("claude-haiku-5-5"), r, false).catch(() => {});
      expect(body.tools?.[1]?.cache_control).toEqual({ type: "ephemeral" });
      expect(body.tools?.[0]?.cache_control).toBeUndefined();
      expect(body.cache_control).toEqual({ type: "ephemeral" });
      // The caller's own definitions are not touched.
      expect((tools[1] as Record<string, unknown>).cache_control).toBeUndefined();
    });
  }
});

describe("anthropicMaxTokens", () => {
  test("current Claude models get the full 128K", () => {
    for (const m of ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1",
      "claude-opus-4-8", "claude-opus-4-6", "claude-sonnet-4-6"]) {
      expect(anthropicMaxTokens(target(m), req)).toBe(128_000);
    }
  });

  test("older models get 32K, which they all accept (128K is a 400 there)", () => {
    for (const m of ["claude-haiku-4-5", "claude-opus-4-1-20250805", "claude-sonnet-4-5-20250929", "claude-something-next"]) {
      expect(anthropicMaxTokens(target(m), req)).toBe(32_000);
    }
  });

  test("an explicit cap still wins", () => {
    expect(anthropicMaxTokens(target("claude-haiku-5-5"), { ...req, maxTokens: 500 })).toBe(500);
  });
});
