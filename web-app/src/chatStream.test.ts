import { expect, test } from "bun:test";
import { finishTool, finishToolIn, parseSse, saveSecret, ThinkSplitter, streamChat, type ChatEvent, whatsappQr } from "./chatStream";

test("SSE records are split on blank lines and keep their event name", () => {
  const { events, rest } = parseSse('data: {"a":1}\n\nevent: tool_start\ndata: {"id":"t1"}\n\ndata: {"par');
  expect(events).toEqual([
    { event: "message", data: '{"a":1}' },
    { event: "tool_start", data: '{"id":"t1"}' },
  ]);
  expect(rest).toBe('data: {"par');
});

test("<think> is split out of the answer, even across chunks", () => {
  const s = new ThinkSplitter();
  expect(s.feed("Hi <thi")).toEqual({ answer: "Hi ", reasoning: "" });
  expect(s.feed("nk>let me see</th")).toEqual({ answer: "", reasoning: "let me see" });
  expect(s.feed("ink> there")).toEqual({ answer: " there", reasoning: "" });
});

const chunk = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

function body(parts: string[], cutShort = false): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode(p));
      if (cutShort) c.error(new Error("connection reset"));
      else c.close();
    },
  });
  return new Response(stream, { status: 200 });
}

async function run(res: Response | Error): Promise<ChatEvent[]> {
  const got: ChatEvent[] = [];
  await streamChat(async () => { if (res instanceof Error) throw res; return res; }, "hello", (e) => got.push(e));
  return got;
}

test("a streamed answer arrives as text, tools as rows, then done", async () => {
  const got = await run(body([
    chunk("Hel"), chunk("lo"),
    'event: tool_start\ndata: {"id":"t1","tool":"web_search"}\n\n',
    'event: tool_done\ndata: {"id":"t1","tool":"web_search","ok":false,"error":"blocked"}\n\n',
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ]));
  expect(got).toEqual([
    { type: "text", text: "Hel" },
    { type: "text", text: "lo" },
    { type: "tool_start", id: "t1", tool: "web_search" },
    { type: "tool_done", id: "t1", tool: "web_search", ok: false },
    { type: "done" },
  ]);
});

test("reasoning_content is reasoning, not answer", async () => {
  const got = await run(body([`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "hmm" } }] })}\n\n`, "data: [DONE]\n\n"]));
  expect(got[0]).toEqual({ type: "reasoning", text: "hmm" });
});

test("an error frame, a cut stream and no engine all end in one error event", async () => {
  const errFrame = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "error" }], error: "402 insufficient credits" })}\n\n`;
  expect((await run(body([errFrame, "data: [DONE]\n\n"]))).at(-1)).toEqual({ type: "error", detail: "402 insufficient credits" });
  expect((await run(body([chunk("Hi")], true))).at(-1)?.type).toBe("error");
  expect((await run(new Error("fetch failed"))).at(-1)?.type).toBe("error");
  expect((await run(new Response("nope", { status: 401 }))).at(-1)).toEqual({ type: "error", detail: "401 nope" });
});

// Shape copied from a real gateway.log (25 Sep): every tool frame carries the
// MESSAGE id, and success sits in result.ok, not at the top level.
test("real tool frames: success is read from result.ok", async () => {
  const id = "0beae56b";
  const got = await run(body([
    `event: tool_start\ndata: ${JSON.stringify({ type: "tool_start", id, tool: "list_skills", args: {} })}\n\n`,
    `event: tool_done\ndata: ${JSON.stringify({ type: "tool_done", id, tool: "list_skills", result: { ok: false, content: "x" } })}\n\n`,
    `event: tool_start\ndata: ${JSON.stringify({ type: "tool_start", id, tool: "connectors_manage", args: {} })}\n\n`,
    `event: tool_done\ndata: ${JSON.stringify({ type: "tool_done", id, tool: "connectors_manage", result: { ok: true } })}\n\n`,
    "data: [DONE]\n\n",
  ]));
  expect(got.filter((e) => e.type === "tool_done")).toEqual([
    { type: "tool_done", id, tool: "list_skills", ok: false },
    { type: "tool_done", id, tool: "connectors_manage", ok: true },
  ]);
});

test("a tool_done lands on the last unfinished row of that tool, not every row with the id", () => {
  const rows = [
    { tool: "list_skills", ok: false as boolean | undefined },
    { tool: "connectors_manage", ok: undefined as boolean | undefined },
  ];
  expect(finishTool(rows, "connectors_manage", true)).toEqual([
    { tool: "list_skills", ok: false },
    { tool: "connectors_manage", ok: true },
  ]);
});

test("the page tells the engine it is the web surface (so request_secret can show a card)", async () => {
  let sent: any;
  await streamChat(async (_u, init) => { sent = JSON.parse(String(init?.body)); return body(["data: [DONE]\n\n"]); }, "hi", () => {});
  expect(sent).toEqual({ content: "hi", session_id: "chat", surface: "web" });
});

test("an ask_user frame with a secret becomes a secure-field event; a plain one becomes a question", async () => {
  const secretQ = { type: "ask_user", id: "req-1", sessionId: "chat", questions: [{ question: "Your Discord bot token", options: [{ label: "Saved" }, { label: "Cancel" }], multiSelect: false, secret: { connector: "discord", field: "DISCORD_TOKEN" } }] };
  const plainQ = { type: "ask_user", id: "req-2", sessionId: "chat", questions: [{ question: "Which server?", options: [{ label: "Home" }, { label: "Work" }], multiSelect: false }] };
  const got = await run(body([`event: ask_user\ndata: ${JSON.stringify(secretQ)}\n\n`, `event: ask_user\ndata: ${JSON.stringify(plainQ)}\n\n`, "data: [DONE]\n\n"]));
  expect(got[0]).toEqual({ type: "secret", requestId: "req-1", question: "Your Discord bot token", connector: "discord", field: "DISCORD_TOKEN" });
  expect(got[1]).toEqual({ type: "ask", requestId: "req-2", question: "Which server?", options: ["Home", "Work"] });
});

test("saving a secret sends the value only to the engine, and only 'Saved' to the agent", async () => {
  const calls: { url: string; body: any }[] = [];
  const f = async (url: string, init?: RequestInit) => { calls.push({ url, body: JSON.parse(String(init?.body)) }); return new Response("{}", { status: 200 }); };
  const ok = await saveSecret(f, { requestId: "req-1", question: "Your Discord bot token", connector: "discord", field: "DISCORD_TOKEN" }, "  tok-123 \n");
  expect(ok).toBe(true);
  expect(calls[0]).toEqual({ url: "/runtime/connectors", body: { id: "discord", secrets: { DISCORD_TOKEN: "tok-123" } } });
  expect(calls[1]).toEqual({ url: "/runtime/ask/respond", body: { requestId: "req-1", answers: [{ question: "Your Discord bot token", selected: ["Saved"] }] } });
  expect(JSON.stringify(calls[1])).not.toContain("tok-123");
});

test("if the engine refuses the save, the agent is not told Saved", async () => {
  const calls: string[] = [];
  const f = async (url: string) => { calls.push(url); return new Response("nope", { status: 500 }); };
  expect(await saveSecret(f, { requestId: "r", question: "q", connector: "discord", field: "DISCORD_TOKEN" }, "tok")).toBe(false);
  expect(calls).toEqual(["/runtime/connectors"]);
});

test("a tool that finishes after its bubble was followed by another still gets its mark", () => {
  // Seen live: request_secret starts in one bubble, the card opens a fresh one,
  // and the tool_done used to land on the fresh one, leaving ⏳ forever.
  const lines = [
    { text: "", tools: [{ tool: "connectors_manage", ok: true }, { tool: "request_secret", ok: undefined as boolean | undefined }] },
    { text: "Enter your token" },
    { text: "", tools: [] as { tool: string; ok?: boolean }[] },
  ];
  const out = finishToolIn(lines, "request_secret", true);
  expect(out[0].tools?.[1]).toEqual({ tool: "request_secret", ok: true });
  expect(out[2]).toBe(lines[2]);
});

test("a tool's progress message becomes a waiting line; an empty one is dropped", async () => {
  const got = await run(body([
    `event: tool_progress\ndata: ${JSON.stringify({ type: "tool_progress", tool: "connectors_pair", stage: "waiting", message: "Send your bot a direct message on Discord now." })}\n\n`,
    `event: tool_progress\ndata: ${JSON.stringify({ type: "tool_progress", tool: "x", stage: "s", message: "" })}\n\n`,
    "data: [DONE]\n\n",
  ]));
  expect(got).toEqual([
    { type: "waiting", tool: "connectors_pair", message: "Send your bot a direct message on Discord now." },
    { type: "done" },
  ]);
});

test("the WhatsApp code is the engine's text, and null when there is none or the engine is gone", async () => {
  const answer = (body: unknown) => async () => new Response(JSON.stringify(body));
  expect(await whatsappQr(answer({ qr: "2@x", ascii: "▀▄", ts: 1 }))).toBe("▀▄");
  expect(await whatsappQr(answer(null))).toBeNull();
  expect(await whatsappQr(async () => { throw new Error("offline"); })).toBeNull();
});
