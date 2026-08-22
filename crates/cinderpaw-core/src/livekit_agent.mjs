// The far end of a LiveKit call, as its own Node process.
//
// Compiled into the Rust binary with `include_str!` and written to disk at
// start. That is not a trick to save a file — it removes the agent from the
// packaging problem entirely: no bundle entry to forget, no resource path that
// differs between `cargo tauri dev` and an installed .app, and no way for the
// script and the Rust that spawns it to drift apart between releases.
//
// What it does today: echo. Whatever it hears, it sends straight back. That is
// deliberately not an assistant — it is the smallest thing that proves the
// whole pipe works inside the real app (server spawned, both ends joined, audio
// travelling in BOTH directions) without an API key, a downloaded model, or a
// vendor account. Nobody can be locked out of running it.
//
// ponytail: echo, not a pipeline. The brain (STT -> LLM -> TTS, or a
// speech-to-speech plugin) replaces the loop at the bottom and nothing else,
// which is the point of proving the transport first.
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';

const [url, token] = process.argv.slice(2);
const RATE = 48000;
const CHANNELS = 1;

const room = new Room();
await room.connect(url, token, { autoSubscribe: true, dynacast: false });

// Published before anyone speaks, not on first audio. A track that appears
// mid-call has to renegotiate while the person is already talking, and the
// first thing they say is the part that gets lost.
const source = new AudioSource(RATE, CHANNELS);
await room.localParticipant.publishTrack(
  LocalAudioTrack.createAudioTrack('cinderpaw-voice', source),
  new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
);

// Printed for Rust, which waits for this line before telling the UI the call is
// up. Without it the webview joins a room where nothing is listening yet, and
// the failure looks like "the first two seconds are always missing".
console.log('CINDERPAW_AGENT_READY');

room.on(RoomEvent.TrackSubscribed, async (track) => {
  if (track.kind !== TrackKind.KIND_AUDIO) return;
  for await (const frame of new AudioStream(track, RATE, CHANNELS)) {
    // Resampled by AudioStream to the rate we asked for, so the frame can go
    // back out unmodified. If that ever stops being true this is where the
    // chipmunk voice comes from.
    await source.captureFrame(
      new AudioFrame(frame.data, RATE, CHANNELS, frame.data.length / CHANNELS),
    );
  }
});

room.on(RoomEvent.Disconnected, () => process.exit(0));
