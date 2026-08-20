/**
 * The microphone as raw 16 kHz mono 16-bit LE PCM.
 *
 * This exists because `MediaRecorder` — what the pipeline call loop uses — only
 * produces container formats (webm/opus), and Gemini Live wants the samples
 * themselves. It is the one piece that was missing to drive the S2S engine.
 *
 * There is no resampling code here on purpose: the `AudioContext` is created AT
 * 16 kHz and the browser resamples the device into it. Writing a resampler when
 * the platform already has one is the expensive way to get a worse one.
 */

import { TARGET_RATE } from './audio';
import { rms } from './vad';

/**
 * Samples per frame. ~128 ms at 16 kHz — small enough that the server's turn
 * detection is not waiting on our buffer, large enough that the IPC hop happens
 * eight times a second rather than sixty.
 */
export const MIC_FRAME = 2048;

/**
 * Float samples (-1..1) → base64 of signed 16-bit little-endian PCM, which is
 * what `send_live_audio` decodes. The exact inverse of `pcm16ToFloat32`.
 */
export function pcm16Base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    // Clamped before scaling: a sample above 1.0 (autoGainControl overshoot,
    // and it happens) wraps around the int16 range and comes out as a click.
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  // Chunked: `String.fromCharCode(...bytes)` on a whole frame is 4096 arguments
  // and a stack overflow waiting for a bigger frame size.
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x2000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  }
  return btoa(binary);
}

/**
 * Open the microphone and hand every frame to `onFrame`, with its loudness so
 * the caller does not need a second analyser node for the level meter.
 *
 * Returns the function that closes everything. Throws if permission is refused —
 * the caller has a screen to put that on.
 */
export async function captureMicPcm(
  /**
   * Raw samples, not base64, and COPIED — `getChannelData` hands back a buffer
   * WebAudio reuses for the next frame, so anything the caller holds on to
   * would be overwritten under it. Handing over samples instead of an encoded
   * string is what lets a caller coalesce several frames into one message when
   * the transport is falling behind; base64 chunks cannot simply be joined,
   * because a 4096-byte frame is not a multiple of three and carries padding.
   */
  onFrame: (samples: Float32Array, level: number) => void,
): Promise<() => void> {
  // Echo cancellation is what stops the model from hearing itself answer and
  // treating it as the user interrupting. In a speech-to-speech call the far end
  // does the turn detection, so getting this wrong is not a stutter, it is a
  // conversation with itself.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });

  const AC: typeof AudioContext =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AC({ sampleRate: TARGET_RATE });
  const source = ctx.createMediaStreamSource(stream);

  // ponytail: ScriptProcessorNode. Deprecated for a decade and still shipped by
  // every Chromium, including the WebView2 this runs in; an AudioWorklet is a
  // second file, a module URL that has to survive the bundler, and a ring buffer
  // to get the frames back across the thread. Move to one if main-thread work
  // ever makes capture drop frames — this is where that would show up.
  const node = ctx.createScriptProcessor(MIC_FRAME, 1, 1);
  node.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    // `rms` reads it synchronously so it can use the live view; the copy is for
    // the caller, which may keep the frame past this callback.
    onFrame(new Float32Array(input), rms(input));
  };

  // A ScriptProcessorNode only runs while its output reaches the destination.
  // Nothing is written to that output, so the connection is silent — the
  // microphone is not fed back to the speakers.
  source.connect(node);
  node.connect(ctx.destination);

  return () => {
    node.onaudioprocess = null;
    node.disconnect();
    source.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    void ctx.close();
  };
}
