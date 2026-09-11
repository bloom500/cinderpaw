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
  const warnings: string[] = [];
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
    console: { log() {}, error: (text: string) => warnings.push(text) },
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; },
    setInterval: (fn: () => void) => { timers.push(fn); return timers.length; },
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
  return { ...api, timers, warnings, deadlines, sessions, context };
}

test("Google keeps realtime input available while a tool is pending", async () => {
  const w = worker("google");
  const model = await w.REALTIME.google();
  expect(model.options.toolBehavior).toBe("NON_BLOCKING");
});

test("Google tool execution does not start a competing filler voice", async () => {
  const w = worker("google");
  await w.toolsFromDeclarations({ say() {} }).ask_cinder.execute({ request: "search" });
  expect(w.timers).toHaveLength(0);
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
  await w.askRust("ask_cinder", { request: "search" });
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
  expect((await w.REALTIME.google()).options.realtimeInputConfig?.automaticActivityDetection).toEqual({
    endOfSpeechSensitivity: "END_SENSITIVITY_LOW", silenceDurationMs: 700, prefixPaddingMs: 300,
  });
  expect(w.warnings).toEqual([]);
});

test("Google tuning accepts valid overrides and rejects malformed settings", async () => {
  const w = worker("google", JSON.stringify({ silenceDurationMs: 900, prefixPaddingMs: -1, extra: true }));
  const config = (await w.REALTIME.google()).options.realtimeInputConfig?.automaticActivityDetection;
  expect(config).toEqual({ endOfSpeechSensitivity: "END_SENSITIVITY_LOW", silenceDurationMs: 900, prefixPaddingMs: 300 });
  expect(w.warnings.length).toBeGreaterThan(0);
  const broken = worker("google", "{");
  expect((await broken.REALTIME.google()).options.realtimeInputConfig.automaticActivityDetection.silenceDurationMs).toBe(700);
  expect(broken.warnings.length).toBeGreaterThan(0);
});
