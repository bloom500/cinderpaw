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
// Two modes, decided by whether a Google key reached us:
//
//   assistant — Gemini's realtime API hears the microphone directly and answers
//               in audio. Turn detection, interruption and synthesis belong to
//               the model, which is the entire reason for choosing it over an
//               STT → LLM → TTS chain we assemble ourselves.
//   echo      — no key: whatever it hears goes straight back. Not a fallback
//               pretending to be an assistant, and it does not claim to be one.
//               It exists so that a machine with nothing set up can still prove
//               its microphone, its speakers and this whole pipe work.
import { cli, defineAgent, voice, WorkerOptions } from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';
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
const API_KEY = process.env.GOOGLE_API_KEY ?? '';
const MODEL = process.env.CINDERPAW_LIVE_MODEL || 'gemini-2.5-flash-native-audio-latest';
const VOICE = process.env.CINDERPAW_LIVE_VOICE || 'Kore';
const INSTRUCTIONS = process.env.CINDERPAW_LIVE_INSTRUCTIONS || '';

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
 * Gemini's realtime API, driven by the Agents session.
 *
 * `AgentSession` owns the microphone track, the playback track, barge-in and
 * the end-of-turn model that loads locally at startup. None of that is ours any
 * more, which was the point of the migration.
 */
async function assistant(ctx) {
  const session = new voice.AgentSession({
    llm: new google.beta.realtime.RealtimeModel({
      apiKey: API_KEY,
      model: MODEL,
      // Pinned. Left unset the server picks per session, so the same assistant
      // answers in a different voice tomorrow — the exact inconsistency that
      // reads as unfinished software.
      voice: VOICE,
    }),
  });

  await session.start({
    agent: new voice.Agent({ instructions: INSTRUCTIONS }),
    room: ctx.room,
  });

  console.log('CINDERPAW_AGENT_READY mode=assistant');

  // Speaking first is not decoration. A person who has just pressed a button
  // and hears nothing cannot tell a working call from a broken one, and the
  // usual response is to hang up during the pause before the first reply.
  session.generateReply();
}

export default defineAgent({
  entry: async (ctx) => {
    await ctx.connect();
    if (API_KEY) {
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
