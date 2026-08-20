/** The rate every speech-recognition path here wants: Whisper's, and Gemini
 *  Live's microphone input. Exported because `micPcm` builds its AudioContext
 *  at it rather than resampling afterwards. */
export const TARGET_RATE = 16_000;

/** Decode a recorded blob to 16 kHz mono f32 PCM via WebAudio (offline resample). */
export async function decodeToPcm16k(blob: Blob): Promise<Float32Array> {
  const arrayBuf = await blob.arrayBuffer();
  // Decode at the device rate first (decodeAudioData ignores the offline rate).
  const AC: typeof AudioContext =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const decodeCtx = new AC();
  const decoded = await decodeCtx.decodeAudioData(arrayBuf);
  await decodeCtx.close();

  const durationSec = decoded.length / decoded.sampleRate;
  const frames = Math.ceil(durationSec * TARGET_RATE);
  const offline = new OfflineAudioContext(1, frames, TARGET_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

const NO_CARRY = new Uint8Array(0);

/**
 * Decode one base64 PCM chunk from `feral://tts-chunk` into Float32 samples.
 *
 * Signed 16-bit little-endian in, -1..1 out, which is what an `AudioBuffer`
 * wants. No `decodeAudioData` involved: the bytes are already raw PCM, so there
 * is nothing to decode and no per-chunk decode latency to pay.
 *
 * `carry` is the point of the return shape. A chunked HTTP response splits
 * wherever the network felt like it, so a chunk can end on the low byte of a
 * sample. Dropping that byte shifts every following sample by one byte — the
 * high and low halves swap for the rest of the utterance, which comes out as
 * loud static rather than as a click you might not notice. Feed the returned
 * `carry` into the next call.
 */
// The return type is inferred deliberately: written out, `Uint8Array` means
// `Uint8Array<ArrayBufferLike>` under TS 5.7's generic typed arrays, which does
// not assign to the `ArrayBuffer`-backed arrays `copyToChannel` demands.
export function pcm16ToFloat32(b64: string, carry: Uint8Array = NO_CARRY) {
  const raw = atob(b64);
  const bytes = new Uint8Array(carry.length + raw.length);
  bytes.set(carry);
  for (let i = 0; i < raw.length; i++) bytes[carry.length + i] = raw.charCodeAt(i);

  const usable = bytes.length - (bytes.length % 2);
  const samples = new Float32Array(usable / 2);
  // An `Int16Array` view instead of a `DataView` call per sample.
  //
  // Measured consequence, not a micro-optimisation: during a Live call this
  // runs on every audio chunk, and the transcript rendered beside it stalled
  // for 1.1–1.9 s on long turns while staying smooth on short ones — the shape
  // of a garbage collection, not of a slow network. Both ends were timed and
  // the bridge was innocent, so the cost is here.
  //
  // Safe because `bytes` was just allocated at offset 0, which is 2-byte
  // aligned by construction. A view over a buffer we did not create would not
  // be, and `Int16Array` throws rather than reading unaligned.
  //
  // Little-endian is assumed, which is what the format is and what every
  // platform this ships on runs.
  const words = new Int16Array(bytes.buffer, 0, usable / 2);
  for (let i = 0; i < words.length; i++) samples[i] = words[i] / 0x8000;

  return { samples, carry: usable === bytes.length ? NO_CARRY : bytes.slice(usable) };
}

/** Normalized 0..1 peak magnitudes, `buckets` of them, for the waveform. */
export function computePeaks(samples: Float32Array, buckets = 48): number[] {
  if (samples.length === 0) return new Array(buckets).fill(0);
  const size = Math.floor(samples.length / buckets) || 1;
  const peaks: number[] = [];
  for (let b = 0; b < buckets; b++) {
    let max = 0;
    const start = b * size;
    for (let i = start; i < start + size && i < samples.length; i++) {
      const v = Math.abs(samples[i]);
      if (v > max) max = v;
    }
    peaks.push(max);
  }
  const norm = Math.max(...peaks, 1e-6);
  return peaks.map((p) => p / norm);
}
