import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Execute the shipped worker, substituting only SDK/network/process boundaries.
// No cloud account or worker process is started by this test.
const source = readFileSync(new URL("../../crates/cinderpaw-core/src/livekit_agent.mjs", import.meta.url), "utf8")
  .split("export default defineAgent(")[0]!
  .replace(/^import\s[\s\S]*?from ['"][^'"]+['"];\r?\n/gm, "");

function worker(provider: string, tuning?: string, env: Record<string, string> = {}) {
  const timers: Array<() => void> = [];
  const delays: number[] = [];
  const warnings: string[] = [];
  const logs: string[] = [];
  const deadlines: number[] = [];
  const sessions: any[] = [];
  // What the worker sent the Gemini plugin directly (userTurn), any session.
  const clientEvents: any[] = [];
  const roomHandlers: Record<string, (payload: Uint8Array) => void> = {};
  class Base { constructor(public options?: any) {} }
  class Session {
    handlers: Record<string, (e: any) => void> = {};
    replies: any[] = [];
    // The plugin's own session, as the worker reaches it through `_activity`.
    _activity = {
      realtimeSession: { sendClientEvent: (e: any) => clientEvents.push(e), handleServerContent: (_c: any) => {} },
    };
    history = { copy: () => ({ truncate: (n: number) => ({ carried: n }) }) };
    constructor(public options: any) { sessions.push(this); }
    on(event: string, fn: (e: any) => void) { this.handlers[event] = fn; }
    async start(_o: any) {}
    generateReply(o: any) { this.replies.push(o); }
    interrupt() {}
  }
  const context = {
    process: { pid: 42, env: {
      CINDERPAW_LIVE_PROVIDER: provider, CINDERPAW_LIVE_VOICE: "vendor-voice",
      CINDERPAW_API_URL: "http://localhost:9999", CINDERPAW_HOME: "/fixture",
      CINDERPAW_LIVE_TOOLS: JSON.stringify([{ name: "ask_cinder", parameters: {}, description: "ask" }]),
      ...env,
    } },
    llm: { LLM: Base, LLMStream: Base, tool: (options: any) => options },
    stt: { STT: Base }, tts: { TTS: Base, ChunkedStream: Base },
    voice: { AgentSession: Session, Agent: Base },
    AgentSessionEventTypes: {
      UserInputTranscribed: "transcribed", ConversationItemAdded: "item", AgentStateChanged: "agent",
      UserStateChanged: "user", Error: "error", Close: "close",
    },
    RoomEvent: { DataReceived: "data" },
    TextDecoder, TextEncoder,
    console: { log: (text: string) => logs.push(String(text)), error: (text: string) => warnings.push(text) },
    // The delay is recorded next to the callback because several timers exist
    // on these paths and "a timer was armed" does not say which: the filler
    // voice (pipeline), the tool-reply nudge (Google), the lookup guard.
    setTimeout: (fn: () => void, ms?: number) => { timers.push(fn); delays.push(ms ?? 0); return timers.length; },
    setInterval: (fn: () => void, ms?: number) => { timers.push(fn); delays.push(ms ?? 0); return timers.length; },
    clearTimeout() {}, clearInterval() {},
    AbortSignal: { timeout: (ms: number) => { deadlines.push(ms); return undefined; } },
    fetch: async () => ({ ok: true, json: async () => ({ response: { ok: true } }) }),
    readFileSync: () => { if (tuning === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return tuning; },
    homedir: () => "/unused", join: (...parts: string[]) => parts.join("/"),
  };
  const api = runInNewContext(source + `
    PLUGIN.google = async () => ({ beta: { realtime: { RealtimeModel: class { constructor(options) { this.options = options; } } } } });
    PLUGIN.openai = async () => ({ realtime: {
      RealtimeModel: class { constructor(options) { this.options = options; } },
      GPTLiveModel: class { constructor(options) { this.options = options; this.live = true; } },
    } });
    ({ REALTIME, toolsFromDeclarations, assistant, askRust, LocalTTS });`, context);
  const room = { on: (event: string, fn: any) => { roomHandlers[event] = fn; }, isConnected: true };
  /** A command from the window, over the data channel. */
  const command = (msg: object) => roomHandlers.data!(new TextEncoder().encode(JSON.stringify(msg)));
  return { ...api, timers, delays, warnings, deadlines, sessions, context, logs, clientEvents, room, command };
}

/** The CINDERPAW_EVENT lines the worker printed for Rust to forward. */
function eventsOf(w: { logs: string[] }) {
  return w.logs.filter((l) => l.startsWith("CINDERPAW_EVENT ")).map((l) => JSON.parse(l.slice("CINDERPAW_EVENT ".length)));
}

/** The text of every turn the worker put in the person's mouth on Gemini. */
function userTurnsOf(w: { clientEvents: any[] }) {
  return w.clientEvents.map((e) => {
    expect(e.type).toBe("content");
    expect(e.value.turns.map((t: any) => t.role)).toEqual(["user"]);
    return e.value.turns[0].parts[0].text as string;
  });
}

/** Let the worker's own awaits (a reopened session builds its model) settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

test("Google keeps realtime input available while a tool is pending", async () => {
  const w = worker("google");
  const model = await w.REALTIME.google();
  expect(model.options.toolBehavior).toBe("NON_BLOCKING");
});

test("Google tool execution asks for the reply as the person and starts no filler voice", async () => {
  const w = worker("google");
  w.context.fetch = async () => ({ ok: true, json: async () => ({ response: { ok: true, output: "Cinderpaw found three articles." } }) });
  const spoken: string[] = [];
  const session: any = new (w.context.voice.AgentSession as any)({});
  session.say = (text: string) => spoken.push(text);
  await w.toolsFromDeclarations(() => session).ask_cinder.execute({ request: "search" });

  // The only timer on Google is the four-second nudge; the filler is never armed.
  expect(w.delays).toEqual([4000]);
  expect(spoken).toEqual([]);

  // Fire it. It used to hand Gemini the ANSWER as a turn the model had said,
  // and a 3.8 model recites its own turns: on 6 Oct an English answer was read
  // out before the Romanian reply. Now the person asks what was found; the
  // answer is already in the model's context as the tool's response.
  w.timers[0]!();
  expect(userTurnsOf(w)).toEqual(["What did you find?"]);
  expect(session.replies).toEqual([]);
});

test("Google is never handed a turn as its own: greeting, typed text, a late answer, a question", async () => {
  const w = worker("google", undefined, { CINDERPAW_LIVE_LANGUAGE: "ro" });
  await w.assistant({ room: w.room });
  w.command({ type: "text", text: "cat e ceasul" });
  w.command({ type: "toolLate", id: "voice-42-9", text: "THE ANSWER" });
  w.command({ type: "ask", text: "Allow Cinderpaw to delete notes.txt? Yes / No" });
  const turns = userTurnsOf(w);
  // The greeting first, in the caller's language, as the person saying hello.
  expect(turns[0]).toBe("Salut!");
  // Typed text is the person's own words. The SDK's userInput path would have
  // ended in an empty turn list on 3.x, which Google rejects: a mute call.
  expect(turns[1]).toBe("cat e ceasul");
  expect(turns[2]!.startsWith("Cinderpaw a terminat")).toBe(true);
  expect(turns[2]).toContain("THE ANSWER");
  expect(turns[3]).toContain("Allow Cinderpaw to delete notes.txt? Yes / No");
  // And nothing went through generateReply, where text becomes a model turn.
  expect(w.sessions[0].replies).toEqual([]);
});

test("a vendor that drops the line gets a fresh session with the conversation, not a dead call", async () => {
  const w = worker("google");
  await w.assistant({ room: w.room });
  const first = w.sessions[0];
  // 6 Oct: Gemini closed with 1011, "Internal error encountered", not retryable.
  first.handlers.error({ error: { type: "realtime_model_error", error: { message: "Internal error encountered.", statusCode: 1011 } } });
  first.handlers.close({ reason: "error" });
  await settle();
  expect(w.sessions).toHaveLength(2);
  const kinds = eventsOf(w).map((e) => e.kind);
  expect(kinds).not.toContain("closed");
  // The vendor's own message reached the screen, not "[object Object]".
  expect(eventsOf(w).some((e) => e.kind === "error" && e.text === "Internal error encountered.")).toBe(true);
  expect(w.logs.some((l) => l.startsWith("CINDERPAW_AGENT_READY"))).toBe(true);
  expect(w.warnings.some((l) => l.startsWith("voice_reopen n=1"))).toBe(true);
});

test("a quota refusal is not reopened: the person needs the reason", async () => {
  const w = worker("google");
  await w.assistant({ room: w.room });
  w.sessions[0].handlers.error({ error: { error: { message: "429 RESOURCE_EXHAUSTED: quota", statusCode: 1008 } } });
  w.sessions[0].handlers.close({ reason: "error" });
  await settle();
  expect(w.sessions).toHaveLength(1);
  expect(eventsOf(w).find((e) => e.kind === "closed")?.text).toContain("RESOURCE_EXHAUSTED");
});

test("Gemini searches on its own, and its search counts as one", async () => {
  const w = worker("google");
  expect((await w.REALTIME.google()).options.geminiTools).toEqual({ googleSearch: {} });
  await w.assistant({ room: w.room });
  w.sessions[0]._activity.realtimeSession.handleServerContent({ groundingMetadata: { webSearchQueries: ["curs euro"] } });
  expect(w.logs.some((l) => l.startsWith("voice_native_search") && l.endsWith("queries=1"))).toBe(true);
});

test("a session Google refuses over the search tool reopens without it", async () => {
  const w = worker("google");
  await w.assistant({ room: w.room });
  w.sessions[0].handlers.error({ error: { error: { message: "google_search is not supported for this model", statusCode: 1007 } } });
  w.sessions[0].handlers.close({ reason: "error" });
  await settle();
  expect(w.sessions).toHaveLength(2);
  expect((await w.REALTIME.google()).options.geminiTools).toBeUndefined();
});

test("the lookup guard does not start a second search while one is still running", async () => {
  const w = worker("google");
  await w.assistant({ room: w.room });
  const s = w.sessions[0];
  // A search the model started in the previous turn, still running.
  w.context.fetch = () => new Promise(() => {});
  void w.toolsFromDeclarations(() => s).ask_cinder.execute({ request: "news" });
  // The person speaks again; the model says it is checking (meaning that search).
  s.handlers.user({ newState: "speaking" });
  s.handlers.user({ newState: "listening" });
  s.handlers.transcribed({ transcript: "si ce mai e nou", isFinal: true });
  s.handlers.item({ item: { role: "assistant", content: ["Verific acum."] } });
  // 6 Oct, turn 4: the guard armed here and ran a second ask_cinder 7 s later.
  expect(w.delays).not.toContain(1500);
});

test("OpenAI runs on GPT-Live, with no second voice and no filler", async () => {
  const w = worker("openai");
  await w.assistant({ room: w.room });
  expect(w.sessions[0].options.llm.live).toBe(true);
  expect(w.sessions[0].options.llm.options.model).toBe("gpt-live-1");
  // A local voice attached to a realtime call talked over the model, on an
  // engine (Piper) no release build has: an error per filler (6 Oct review).
  expect(w.sessions[0].options.tts).toBeUndefined();
  const before = w.timers.length;
  await w.toolsFromDeclarations(() => w.sessions[0]).ask_cinder.execute({ request: "search" });
  expect(w.timers.length).toBe(before);
});

test("a stored gpt-realtime pick still runs on the realtime model, with the caller's language", async () => {
  const w = worker("openai", undefined, { CINDERPAW_LIVE_MODEL: "gpt-realtime", CINDERPAW_LIVE_LANGUAGE: "ro" });
  const model = await w.REALTIME.openai();
  expect(model.live).toBeUndefined();
  expect(model.options.inputAudioTranscription).toEqual({ model: "whisper-1", language: "ro" });
});

test("worker request remains alive until after Rust can send its holding reply", async () => {
  const rust = readFileSync(new URL("../../crates/cinderpaw-core/src/api.rs", import.meta.url), "utf8");
  const seconds = Number(rust.match(/VOICE_TOOL_DEADLINE[^=]*=\s*std::time::Duration::from_secs\((\d+)\)/)![1]);
  const w = worker("openai");
  await w.askRust("voice-42-1", "ask_cinder", { request: "search" });
  expect(w.deadlines[0]).toBeGreaterThan(seconds * 1000);
});

test("local synthesis sends the engine voice rather than the realtime vendor voice", async () => {
  const w = worker("openai");
  const requests: any[] = [];
  w.context.fetch = (async (_url: string, options: any) => {
    requests.push(JSON.parse(options.body));
    throw new Error("stop before audio playback");
  }) as any;
  for (const name of [null, "local-voice"]) {
    const stream = new w.LocalTTS(name).synthesize("hello");
    await expect(stream.run()).rejects.toThrow("stop before audio playback");
  }
  expect(requests.map((r) => r.voice)).toEqual([null, "local-voice"]);
});

test("Google uses patient endpointing without a tuning file", async () => {
  const w = worker("google");
  // 1500, not 700, since 2026-09-18 (a0102bf). The pause between two spoken
  // sentences is routinely longer than 700 ms, so a three-sentence request was
  // cut after the first one: the model began answering, sentence two arrived as
  // an interruption, and the answer was cancelled. On a real call that produced
  // no reply at all. The number is the product decision, so it is asserted here
  // rather than read out of the worker - a test that reads the value it checks
  // cannot catch the value changing.
  expect((await w.REALTIME.google()).options.realtimeInputConfig?.automaticActivityDetection).toEqual({
    endOfSpeechSensitivity: "END_SENSITIVITY_LOW", silenceDurationMs: 1500, prefixPaddingMs: 300,
  });
  expect(w.warnings).toEqual([]);
});

test("Google tuning accepts valid overrides and rejects malformed settings", async () => {
  const w = worker("google", JSON.stringify({ silenceDurationMs: 900, prefixPaddingMs: -1, extra: true }));
  const config = (await w.REALTIME.google()).options.realtimeInputConfig?.automaticActivityDetection;
  expect(config).toEqual({ endOfSpeechSensitivity: "END_SENSITIVITY_LOW", silenceDurationMs: 900, prefixPaddingMs: 300 });
  expect(w.warnings.length).toBeGreaterThan(0);
  const broken = worker("google", "{");
  // A tuning file that will not parse falls back to the shipped default, which
  // is the patient one. See the test above for why it is 1500.
  expect((await broken.REALTIME.google()).options.realtimeInputConfig.automaticActivityDetection.silenceDurationMs).toBe(1500);
  expect(broken.warnings.length).toBeGreaterThan(0);
});

test("every tool event names its call and its session, and a held answer is marked pending", async () => {
  const w = worker("google");
  // Rust answered "still working": ok:false and pending:true, the row must
  // stay open (Astra, 19 Sep 2026: rows were matched by tool NAME, and a
  // result closed whichever ask_cinder row was newest).
  w.context.fetch = async () => ({ ok: true, json: async () => ({ response: { ok: false, pending: true, output: "Still working" } }) });
  const session = { say() {}, generateReply() {} };
  await w.toolsFromDeclarations(() => session).ask_cinder.execute({ request: "search" });
  const events = eventsOf(w);
  expect(events.map((e) => e.kind)).toEqual(["toolCall", "toolResult"]);
  expect(events[0]).toMatchObject({ id: "voice-42-1", session: "voice-42", tool: "ask_cinder", text: "search" });
  expect(events[1]).toMatchObject({ id: "voice-42-1", session: "voice-42", pending: true });
  // And the greppable line with the same id.
  expect(w.logs.some((l) => l.startsWith("voice_tool_call id=voice-42-1 "))).toBe(true);
  // A second call is a second id.
  await w.toolsFromDeclarations(() => session).ask_cinder.execute({ request: "again" });
  expect(eventsOf(w)[2].id).toBe("voice-42-2");
});
