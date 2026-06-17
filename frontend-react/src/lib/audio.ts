const TARGET_RATE = 16_000;

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
