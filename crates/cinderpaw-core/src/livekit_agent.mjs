// The far end of a LiveKit call, as its own Node process.
//
// Compiled into the Rust binary with `include_str!` and written to disk at
// start. That is not a trick to save a file — it removes the agent from the
// packaging problem entirely: no bundle entry to forget, no resource path that
// differs between `cargo tauri dev` and an installed .app, and no way for the
// script and the Rust that spawns it to drift apart between releases.
//
// It registers as a worker with NO agent name, which is what makes LiveKit
// dispatch it automatically to every room that opens. The alternative — a named
// agent plus an explicit dispatch call — is the same behaviour with a REST
// client in Rust to maintain.
//
// Two modes, decided by whether a key reached us:
//
//   assistant — the chosen vendor's realtime API hears the microphone directly
//               and answers in audio. Turn detection, interruption and
//               synthesis belong to the model, which is the entire reason for
//               choosing speech-to-speech over an STT → LLM → TTS chain we
//               assemble ourselves.
//   echo      — no key: whatever it hears goes straight back. Not a fallback
//               pretending to be an assistant, and it does not claim to be one.
//               It exists so that a machine with nothing set up can still prove
//               its microphone, its speakers and this whole pipe work.
//
// No vendor is imported at the top of this file. Rust names one in
// CINDERPAW_LIVE_PROVIDER and installs that plugin and no other, so a static
// import of Google's would crash an OpenAI call on `ERR_MODULE_NOT_FOUND`
// before a single line of this ran — and in a forked job process, where the
// error goes to a log nobody has open rather than to the screen.
import {
  AgentSessionEventTypes,
  cli,
  defineAgent,
  DEFAULT_API_CONNECT_OPTIONS,
  llm,
  stt,
  tts,
  voice,
  WorkerOptions,
} from '@livekit/agents';
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import { fileURLToPath } from 'node:url';

const RATE = 48000;
const CHANNELS = 1;

/** No key ⇒ echo. Read once, so the mode cannot change mid-call. */
const API_KEY = process.env.CINDERPAW_LIVE_API_KEY ?? '';
/** Which vendor Rust resolved. Empty is echo, and echo needs no plugin. */
const PROVIDER = process.env.CINDERPAW_LIVE_PROVIDER ?? '';
const MODEL = process.env.CINDERPAW_LIVE_MODEL || '';
const VOICE = process.env.CINDERPAW_LIVE_VOICE || '';
const INSTRUCTIONS = process.env.CINDERPAW_LIVE_INSTRUCTIONS || '';
/** Local pipeline only: which on-device engines to use. */
const STT_MODEL = process.env.CINDERPAW_LIVE_STT_MODEL || 'small';
const TTS_ENGINE = process.env.CINDERPAW_LIVE_TTS_ENGINE || 'piper';

/**
 * How each vendor's realtime model is constructed.
 *
 * The differences are real and not worth hiding behind an adapter: Google takes
 * `contextWindowCompression`, OpenAI takes `turnDetection`, and the two
 * transcription options are spelled differently on each. One function per
 * vendor says exactly what that vendor is given, which is what somebody
 * debugging a call at 3am actually needs to read.
 *
 * The import is dynamic and inside the function so that only the plugin Rust
 * installed is ever loaded.
 */
/**
 * The local pipeline: this machine hears, this machine thinks, this machine
 * speaks.
 *
 * Speech-to-speech needs a cloud key by definition — one vendor's session does
 * all three parts. That is fine as an option and wrong as the only one: Piper
 * ships five Romanian voices that exist nowhere else, Whisper runs on the CPU,
 * and a local-first product whose voice feature requires an account has quietly
 * stopped being local-first.
 *
 * None of the three pieces live in this process. They live in the Rust binary
 * that spawned it, reached over the same loopback API and the same bearer token
 * the tool calls already use — so this adds no new door, no new port and no
 * second copy of a model.
 */
class LocalSTT extends stt.STT {
  label = 'cinderpaw.LocalSTT';
  constructor() {
    // Not streaming: Whisper transcribes a finished utterance, not a live
    // stream. Declaring it honestly is what makes the SDK wrap this in its own
    // VAD-driven adapter — claiming `streaming: true` would have the framework
    // wait for interim results that never arrive, and the call would hear
    // nothing while looking connected.
    super({ streaming: false, interimResults: false });
  }
  get provider() { return 'cinderpaw'; }
  get model() { return STT_MODEL; }

  async _recognize(buffer) {
    const { data, sampleRate } = flatten(buffer);
    const pcm = toFloat32(data, sampleRate, 16000); // what Whisper wants
    const res = await fetch(`${API_URL}/runtime/voice/transcribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({ pcm: Array.from(pcm), model_size: STT_MODEL }),
    });
    if (!res.ok) {
      const why = await res.text();
      // Thrown, not returned empty. An empty transcript is indistinguishable
      // from a person who said nothing, and "the model is not downloaded" is
      // exactly the failure somebody can act on if they are told.
      throw new Error(why === 'model-missing'
        ? 'The local transcription model is not downloaded yet (Settings → General).'
        : `Local transcription failed: ${why}`);
    }
    const { text } = await res.json();
    return {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [{ text: text ?? '', language: '', startTime: 0, endTime: 0, confidence: 1 }],
    };
  }
}

/** One utterance of local synthesis, pulled as PCM and pushed as frames. */
class LocalTTSStream extends tts.ChunkedStream {
  label = 'cinderpaw.LocalTTSStream';
  async run() {
    const res = await fetch(`${API_URL}/runtime/voice/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({ provider: TTS_ENGINE, voice: VOICE || null, text: this.inputText }),
      signal: this.abortSignal,
    });
    if (!res.ok) throw new Error(`Local speech failed: ${await res.text()}`);
    // The engine's rate, not a constant. Piper voices are 22.05 kHz and playing
    // those at 24 makes the voice fast and high while looking like it works.
    const rate = Number(res.headers.get('x-sample-rate')) || 24000;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
    const requestId = String(++nextCallId);
    this.queue.put({
      requestId,
      segmentId: requestId,
      frame: new AudioFrame(samples, rate, 1, samples.length),
      final: true,
    });
    this.queue.close();
  }
}

class LocalTTS extends tts.TTS {
  label = 'cinderpaw.LocalTTS';
  constructor() {
    // The rate declared here is what the session resamples TO; the frames
    // themselves carry the engine's real rate, which is why the header above
    // is read rather than assumed.
    super(24000, 1, { streaming: false });
  }
  get provider() { return 'cinderpaw'; }
  get model() { return TTS_ENGINE; }
  synthesize(text, connOptions, abortSignal) {
    return new LocalTTSStream(text, this, connOptions, abortSignal);
  }
}

/** The local model, over the same `/runtime/chat` the rest of the app uses. */
class LocalLLMStream extends llm.LLMStream {
  label = 'cinderpaw.LocalLLMStream';
  async run() {
    const messages = this.chatCtx.items
      .filter((i) => i.type === 'message')
      .map((i) => ({
        role: i.role === 'assistant' ? 'assistant' : i.role === 'system' ? 'system' : 'user',
        content: Array.isArray(i.content)
          ? i.content.filter((c) => typeof c === 'string').join(' ')
          : String(i.content ?? ''),
      }));
    const res = await fetch(`${API_URL}/runtime/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({ messages, system: INSTRUCTIONS || undefined, stream: false }),
      signal: this.abortSignal,
    });
    if (!res.ok) throw new Error(`Local model failed: ${await res.text()}`);
    const body = await res.json();
    const text = body.content ?? body.text ?? body.message?.content ?? '';
    this.queue.put({
      id: String(++nextCallId),
      delta: { role: 'assistant', content: String(text) },
    });
    this.queue.close();
  }
}

class LocalLLM extends llm.LLM {
  label() { return 'cinderpaw.LocalLLM'; }
  get provider() { return 'cinderpaw'; }
  chat({ chatCtx, toolCtx, connOptions }) {
    // `connOptions` is optional on `chat` and REQUIRED by the stream. Passing
    // it through undefined compiles and then loses every retry and timeout the
    // framework sets, which shows up as a call that hangs instead of failing.
    return new LocalLLMStream(this, {
      chatCtx,
      toolCtx,
      connOptions: connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
    });
  }
}

/** `AudioBuffer` is a frame or a list of them; both have to work. */
function flatten(buffer) {
  const frames = Array.isArray(buffer) ? buffer : [buffer];
  const sampleRate = frames[0]?.sampleRate ?? 48000;
  const total = frames.reduce((n, f) => n + f.data.length, 0);
  const data = new Int16Array(total);
  let at = 0;
  for (const f of frames) { data.set(f.data, at); at += f.data.length; }
  return { data, sampleRate };
}

/**
 * Int16 at one rate → float32 at another.
 *
 * Nearest-sample, deliberately: this feeds a speech recogniser, the ratio is a
 * downsample from 48k to 16k, and the artefacts a proper filter would remove
 * sit above the band Whisper reads. A resampling library here would be a
 * dependency for a difference the model cannot hear.
 */
function toFloat32(data, from, to) {
  const ratio = from / to;
  const out = new Float32Array(Math.floor(data.length / ratio));
  for (let i = 0; i < out.length; i++) out[i] = data[Math.floor(i * ratio)] / 32768;
  return out;
}

const REALTIME = {
  google: async () => {
    const google = await import('@livekit/agents-plugin-google');
    return new google.beta.realtime.RealtimeModel({
      apiKey: API_KEY,
      model: MODEL || 'gemini-2.5-flash-native-audio-latest',
      // Pinned. Left unset the server picks per session, so the same assistant
      // answers in a different voice tomorrow — the exact inconsistency that
      // reads as unfinished software.
      voice: VOICE || 'Kore',
      // A Live session is bounded by its context window, not by the clock: fill
      // it and the server ends the session mid-sentence. A sliding window drops
      // the oldest turns instead, which is what makes "talk for an hour" a thing
      // that can happen at all. Left off, a long conversation has a hard stop
      // nobody warned the person about.
      contextWindowCompression: { slidingWindow: {} },
      // Both sides transcribed. Not decoration: it is the only way to see what
      // the model actually HEARD, and mishearing is the failure that looks like
      // stupidity. Also what a call needs to leave behind a readable trace.
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      instructions: INSTRUCTIONS,
    });
  },
  openai: async () => {
    const openai = await import('@livekit/agents-plugin-openai');
    return new openai.realtime.RealtimeModel({
      apiKey: API_KEY,
      model: MODEL || 'gpt-realtime',
      voice: VOICE || 'marin',
      // The server-side voice activity detector, asked for explicitly. Left to
      // the default this is still on, but "still on by default" is a thing that
      // changes between API versions and takes barge-in with it when it does.
      turnDetection: { type: 'server_vad' },
      // Google transcribes both directions from one option each; OpenAI only
      // transcribes the INPUT, and the output transcript arrives as part of the
      // response. Asking for the input one is therefore not symmetry — it is
      // the only half that has to be requested.
      inputAudioTranscription: { model: 'whisper-1' },
      instructions: INSTRUCTIONS,
    });
  },
};
/** Declared by Rust, not here. See `live::bridge::declarations`. */
const TOOL_DECLARATIONS = JSON.parse(process.env.CINDERPAW_LIVE_TOOLS || '[]');

/**
 * Tool calls, answered over the app's own loopback API.
 *
 * NOT over the pipe to the parent, which is where this started and where it
 * failed: the Agents SDK forks a supervised child process per call, this file
 * is loaded again inside it, and that child does not own the worker's stdin.
 * Reading stdin there took over the channel the runner uses to start, so every
 * job died with `runner initialization timed out` and the room stayed empty.
 *
 * An HTTP call works from any process, forked or not. It reaches the same agent
 * the bearer token already reaches through `/runtime/chat`, so it grants
 * nothing new.
 */
const API_URL = process.env.CINDERPAW_API_URL || '';
const API_TOKEN = process.env.CINDERPAW_API_TOKEN || '';
let nextCallId = 0;

async function askRust(name, args) {
  if (!API_URL) return { ok: false, output: 'Cinderpaw is not reachable from here' };
  try {
    const res = await fetch(`${API_URL}/runtime/voice/tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({ id: String(++nextCallId), name, args }),
      // A backstop above Rust's own twenty-second budget, not a second policy.
      // A realtime session BLOCKS on a tool call, so anything that can hang
      // here — a dead API server, a socket that never answers — is a call that
      // goes silent mid-sentence with no way back.
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return { ok: false, output: `Cinderpaw refused the request (${res.status})` };
    const { response } = await res.json();
    return response;
  } catch (e) {
    // Spoken, not thrown. An exception here ends the turn with nothing said,
    // which the person hears as the assistant simply stopping.
    return {
      ok: false,
      output: `Could not reach Cinderpaw for that (${String(e?.message ?? e)}). Say so out loud.`,
    };
  }
}

/** Build the LiveKit tool set from what Rust declared. */
function toolsFromDeclarations() {
  const out = {};
  for (const decl of TOOL_DECLARATIONS) {
    out[decl.name] = llm.tool({
      description: decl.description,
      // The JSON Schema Rust already wrote. Restating it as a zod schema here
      // would be a second definition of the same contract, free to drift.
      parameters: decl.parameters,
      // The agent's turn takes around twenty-five seconds, which is why the
      // declaration tells the model to keep talking while it waits. Nothing
      // here needs a timeout: a call that ends takes the process with it.
      execute: async (args) => askRust(decl.name, args),
    });
  }
  return out;
}

/**
 * Whatever it hears, straight back out.
 *
 * The track is published before anyone speaks rather than on first audio: a
 * track that appears mid-call renegotiates while the person is already talking,
 * and the first thing they say is the part that gets lost.
 */
async function echo(ctx) {
  const source = new AudioSource(RATE, CHANNELS);
  await ctx.room.localParticipant.publishTrack(
    LocalAudioTrack.createAudioTrack('cinderpaw-voice', source),
    new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
  );
  console.log('CINDERPAW_AGENT_READY mode=echo');

  ctx.room.on(RoomEvent.TrackSubscribed, async (track) => {
    if (track.kind !== TrackKind.KIND_AUDIO) return;
    for await (const frame of new AudioStream(track, RATE, CHANNELS)) {
      // AudioStream resamples to the rate we asked for, so the frame goes back
      // out unmodified. If that ever stops being true, this is where the
      // chipmunk voice comes from.
      await source.captureFrame(
        new AudioFrame(frame.data, RATE, CHANNELS, frame.data.length / CHANNELS),
      );
    }
  });
}

/**
 * The chosen vendor's realtime API, driven by the Agents session.
 *
 * `AgentSession` owns the microphone track, the playback track, barge-in and
 * the end-of-turn model that loads locally at startup. None of that is ours any
 * more, which was the point of the migration — and none of it is vendor
 * specific either, which is why swapping the vendor is one line here.
 */
async function assistant(ctx, makeSession) {
  // The local pipeline builds its own session; every cloud vendor builds one
  // from `REALTIME`. Everything AFTER this point — events, tools, the data
  // channel, the greeting — is identical, which is the only reason there is one
  // function here instead of two that drift.
  const build = makeSession ? null : REALTIME[PROVIDER];
  if (!makeSession && !build) {
    // Reachable only if Rust names a vendor this file does not know, i.e. after
    // a half-applied update. Said out loud in the same channel as every other
    // failure rather than thrown, because a throw here ends the job with an
    // empty room and no explanation anywhere the user can see.
    console.log(
      'CINDERPAW_EVENT ' +
        JSON.stringify({
          kind: 'error',
          text: `This build does not know the voice provider "${PROVIDER}".`,
          recoverable: false,
        }),
    );
    return echo(ctx);
  }
  const session = makeSession ? await makeSession(ctx) : new voice.AgentSession({ llm: await build() });

  // One line per event, on stdout, for Rust to forward to the window. A prefix
  // rather than a side channel because the pipe already exists and a second one
  // is a second thing that can be half-connected.
  const emit = (obj) => console.log('CINDERPAW_EVENT ' + JSON.stringify(obj));

  session.on(AgentSessionEventTypes.UserInputTranscribed, (e) => {
    // Interim results change several times a second. Forwarding them would put
    // a flickering half-sentence on screen; the final one is the transcript.
    if (e.isFinal && e.transcript?.trim()) emit({ kind: 'heard', text: e.transcript.trim() });
  });

  session.on(AgentSessionEventTypes.ConversationItemAdded, (e) => {
    const item = e.item;
    if (item?.role !== 'assistant') return;
    const text = Array.isArray(item.content)
      ? item.content.filter((c) => typeof c === 'string').join(' ').trim()
      : String(item.textContent ?? '').trim();
    if (text) emit({ kind: 'said', text });
  });

  // The free Gemini tier rate-limits voice, and a session that dies from quota
  // is indistinguishable from a broken app unless something says so. The plugin
  // resumes a dropped session on its own using a resumption handle, so this
  // reports rather than reconnects — but a quota refusal is not resumable, and
  // that is exactly the case a person needs told.
  // What the call is DOING, so the screen can say so. The overlay has always
  // had four states; without this it would have to guess them from audio
  // energy, which is how a call that is thinking looks identical to one that
  // has died.
  session.on(AgentSessionEventTypes.AgentStateChanged, (e) => {
    emit({ kind: 'state', text: String(e.newState ?? '') });
  });

  session.on(AgentSessionEventTypes.Error, (e) => {
    const message = String(e?.error?.message ?? e?.error ?? 'unknown error');
    emit({ kind: 'error', text: message, recoverable: Boolean(e?.recoverable) });
  });
  session.on(AgentSessionEventTypes.Close, () => emit({ kind: 'closed' }));

  // Commands from the window, over LiveKit's own data channel.
  //
  // The window is IN the room, so this needs no extra socket and no port: it
  // is the same connection the audio already travels on. It carries the two
  // things a person can do to a call that speech alone cannot express — cutting
  // the assistant off mid-sentence, and typing a word dictation keeps mangling
  // (a URL, a name, an error string).
  ctx.room.on(RoomEvent.DataReceived, (payload) => {
    let msg;
    try {
      msg = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return; // not ours
    }
    if (msg.type === 'interrupt') session.interrupt();
    // `userInput`, not `say`: `say` would make the assistant read the text out
    // loud in its own voice, which is the opposite of what typing into a call
    // means.
    if (msg.type === 'text' && msg.text) session.generateReply({ userInput: String(msg.text) });
  });

  await session.start({
    agent: new voice.Agent({ instructions: INSTRUCTIONS, tools: toolsFromDeclarations() }),
    room: ctx.room,
  });

  console.log(
    `CINDERPAW_AGENT_READY mode=assistant provider=${PROVIDER} persona=${INSTRUCTIONS.length} tools=${TOOL_DECLARATIONS.length}`,
  );

  // Speaking first is not decoration. A person who has just pressed a button
  // and hears nothing cannot tell a working call from a broken one, and the
  // usual response is to hang up during the pause before the first reply.
  session.generateReply();
}

/**
 * A call that never leaves this machine.
 *
 * Same `AgentSession` as the realtime path — same barge-in, same turn
 * detection, same transcripts, same tools — assembled from three local parts
 * instead of one remote session. That symmetry is the point: the overlay, the
 * event stream and the tool bridge below do not know which mode is running.
 *
 * The VAD is not optional here. A non-streaming recogniser has no idea when a
 * sentence ended, so without it the session would either never submit audio or
 * submit all of it at once.
 */
async function pipeline(ctx) {
  const silero = await import('@livekit/agents-plugin-silero');
  const session = new voice.AgentSession({
    stt: new LocalSTT(),
    llm: new LocalLLM(),
    tts: new LocalTTS(),
    vad: await silero.VAD.load(),
  });
  return session;
}

export default defineAgent({
  entry: async (ctx) => {
    await ctx.connect();
    // Local needs no key at all — that is the whole reason it exists — so it is
    // checked before the key test rather than falling through it.
    if (PROVIDER === 'local') {
      await assistant(ctx, pipeline);
    } else if (API_KEY && PROVIDER) {
      // Both halves have to be present. A provider with no key authenticates
      // nothing, and a key with no provider has no plugin to hand it to; either
      // one alone used to be enough to take the assistant branch and then fail
      // somewhere further in, which is a call that connects and never speaks.
      await assistant(ctx);
    } else {
      await echo(ctx);
    }
  },
});

cli.runApp(
  new WorkerOptions({
    agent: fileURLToPath(import.meta.url),
    // No `agentName`: that is what makes LiveKit dispatch this worker into any
    // room that opens, with no dispatch call from our side.
    wsURL: process.env.LIVEKIT_URL,
    apiKey: process.env.LIVEKIT_API_KEY,
    apiSecret: process.env.LIVEKIT_API_SECRET,
  }),
);
