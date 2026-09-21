import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Execute the shipped worker, substituting only SDK/network/process boundaries.
// No cloud account or worker process is started by this test.
const source = readFileSync(new URL("../../crates/cinderpaw-core/src/livekit_agent.mjs", import.meta.url), "utf8")
  .split("export default defineAgent(")[0]!
  .replace(/^import\s[\s\S]*?from ['"][^'"]+['"];\r?\n/gm, "");

function worker(provider: string, tuning?: string) {
  const timers: Array<() => void> = [];
  const delays: number[] = [];
  const warnings: string[] = [];
  const logs: string[] = [];
  const deadlines: number[] = [];
  const sessions: any[] = [];
  class Base {}
  class Session {
    constructor(public options: any) { sessions.push(this); }
    on() {}
    async start() {}
    generateReply() {}
  }
  const context = {
    process: { pid: 42, env: {
      CINDERPAW_LIVE_PROVIDER: provider, CINDERPAW_LIVE_VOICE: "vendor-voice",
      CINDERPAW_API_URL: "http://localhost:9999", CINDERPAW_HOME: "/fixture",
      CINDERPAW_LIVE_TOOLS: JSON.stringify([{ name: "ask_cinder", parameters: {}, description: "ask" }]),
    } },
    llm: { LLM: Base, LLMStream: Base, tool: (options: any) => options },
    stt: { STT: Base }, tts: { TTS: Base, ChunkedStream: Base },
    voice: { AgentSession: Session, Agent: Base },
    AgentSessionEventTypes: {}, RoomEvent: {},
    console: { log: (text: string) => logs.push(String(text)), error: (text: string) => warnings.push(text) },
    // The delay is recorded next to the callback because two different timers
    // now exist on this path and "a timer was armed" no longer says which:
    // the filler voice (OpenAI) and the tool-reply nudge (Google).
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
    PLUGIN.openai = async () => ({ realtime: { RealtimeModel: class { constructor(options) { this.options = options; } } } });
    ({ REALTIME, toolsFromDeclarations, assistant, askRust, LocalTTS });`, context);
  return { ...api, timers, delays, warnings, deadlines, sessions, context, logs };
}

/** The CINDERPAW_EVENT lines the worker printed for Rust to forward. */
function eventsOf(w: { logs: string[] }) {
  return w.logs.filter((l) => l.startsWith("CINDERPAW_EVENT ")).map((l) => JSON.parse(l.slice("CINDERPAW_EVENT ".length)));
}

test("Google keeps realtime input available while a tool is pending", async () => {
  const w = worker("google");
  const model = await w.REALTIME.google();
  expect(model.options.toolBehavior).toBe("NON_BLOCKING");
});

test("Google tool execution asks for the reply and starts no competing filler voice", async () => {
  const w = worker("google");
  w.context.fetch = async () => ({ ok: true, json: async () => ({ response: { ok: true, output: "Cinderpaw a gasit trei articole." } }) });
  const spoken: string[] = [];
  const replies: Array<{ instructions?: string }> = [];
  const session = {
    say: (text: string) => spoken.push(text),
    generateReply: (o: { instructions?: string; userInput?: string }) => replies.push(o),
  };
  await w.toolsFromDeclarations(session).ask_cinder.execute({ request: "search" });

  // This test used to say "no timer at all", which was the right assertion
  // while the only timer on this path was the filler. Since 2026-09-18 there
  // is a second one: Gemini 3.x finds a tool's answer and says nothing, so the
  // reply is asked for four seconds later if nobody has started speaking. The
  // filler is still never armed on Google — the distinction is the delay.
  expect(w.delays).toEqual([4000]);
  expect(spoken).toEqual([]);

  // Fire it: what it does is ask for the answer to be spoken, not speak.
  w.timers[0]!();
  expect(replies).toHaveLength(1);
  // `instructions` is roughly what a 3.8 Live model SAYS (the plugin sends it
  // as a "model" turn), so it carries the answer itself, in the caller's
  // language, and never a sentence about the answer: on 20 Sep "tell the user
  // in Romanian…" was read aloud in English and the result never came.
  // `userInput` is not an option either: on 3.x it ends in an empty turn list
  // that Google rejects and the call goes mute.
  expect(replies[0]!.instructions).toBe("Cinderpaw a gasit trei articole.");
  expect(replies[0]!.userInput).toBeUndefined();
});

test("OpenAI realtime filler has a TTS without passing the vendor voice to it", async () => {
  const w = worker("openai");
  await w.assistant({ room: { on() {} } });
  expect(w.sessions[0].options.tts).toBeDefined();
  expect(w.sessions[0].options.tts.voiceName).toBeNull();
  await w.toolsFromDeclarations({ say() {} }).ask_cinder.execute({ request: "search" });
  expect(w.timers.length).toBeGreaterThan(0);
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
  await w.toolsFromDeclarations(session).ask_cinder.execute({ request: "search" });
  const events = eventsOf(w);
  expect(events.map((e) => e.kind)).toEqual(["toolCall", "toolResult"]);
  expect(events[0]).toMatchObject({ id: "voice-42-1", session: "voice-42", tool: "ask_cinder", text: "search" });
  expect(events[1]).toMatchObject({ id: "voice-42-1", session: "voice-42", pending: true });
  // And the greppable line with the same id.
  expect(w.logs.some((l) => l.startsWith("voice_tool_call id=voice-42-1 "))).toBe(true);
  // A second call is a second id.
  await w.toolsFromDeclarations(session).ask_cinder.execute({ request: "again" });
  expect(eventsOf(w)[2].id).toBe("voice-42-2");
});
