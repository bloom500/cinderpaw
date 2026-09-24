import { expect, test } from "bun:test";
import { parseSse, ThinkSplitter, streamChat, type ChatEvent } from "./chatStream";

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
