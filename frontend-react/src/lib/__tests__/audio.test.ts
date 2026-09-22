import { describe, it, expect } from 'vitest';
import { computePeaks, pcm16ToFloat32, wavBlob } from '../audio';

/** base64 of raw bytes, the way Rust's `speak_text` encodes a PCM chunk. */
const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

describe('pcm16ToFloat32', () => {
  it('reads signed little-endian 16-bit into -1..1', () => {
    //   0x0000 = silence, 0x7FFF = full positive, 0x8000 = full negative
    const { samples, carry } = pcm16ToFloat32(b64([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80]));
    expect(carry).toHaveLength(0);
    expect(samples[0]).toBe(0);
    expect(samples[1]).toBeCloseTo(1, 4);
    expect(samples[2]).toBe(-1);
  });

  it('carries a split sample into the next chunk instead of dropping it', () => {
    // The network cut between the two bytes of a single 0x7FFF sample.
    const first = pcm16ToFloat32(b64([0xff]));
    expect(first.samples).toHaveLength(0);
    expect(first.carry).toHaveLength(1);

    const second = pcm16ToFloat32(b64([0x7f, 0x00, 0x00]), first.carry);
    expect(second.samples).toHaveLength(2);
    expect(second.samples[0]).toBeCloseTo(1, 4); // reassembled across the split
    expect(second.samples[1]).toBe(0);
    expect(second.carry).toHaveLength(0);
  });
});

describe('computePeaks', () => {
  it('returns the requested number of buckets', () => {
    const s = new Float32Array(1000).map((_, i) => Math.sin(i / 5));
    expect(computePeaks(s, 16)).toHaveLength(16);
  });

  it('normalizes peaks into 0..1 with the max bucket at 1', () => {
    const s = new Float32Array(100).fill(0);
    s[50] = 0.5; // single loud sample
    const peaks = computePeaks(s, 10);
    expect(Math.max(...peaks)).toBeCloseTo(1, 5);
    expect(Math.min(...peaks)).toBeGreaterThanOrEqual(0);
  });

  it('handles silence without NaN', () => {
    const peaks = computePeaks(new Float32Array(100), 8);
    expect(peaks.every((p) => Number.isFinite(p))).toBe(true);
  });
});

describe('wavBlob', () => {
  const bytes = async (pcm: Float32Array, rate?: number) =>
    new DataView(await (rate === undefined ? wavBlob(pcm) : wavBlob(pcm, rate)).arrayBuffer());
  const ascii = (v: DataView, at: number, s: string) => {
    for (let i = 0; i < s.length; i++) expect(v.getUint8(at + i)).toBe(s.charCodeAt(i));
  };

  it('states its length by shape: RIFF/WAVE/fmt/data and a 44-byte header', async () => {
    const v = await bytes(new Float32Array([0, 0, 0, 0]));
    expect(v.byteLength).toBe(44 + 4 * 2);
    expect(v.getUint32(4, true)).toBe(36 + 4 * 2); // chunk size
    expect(v.getUint32(40, true)).toBe(4 * 2); // data size
    ascii(v, 0, 'RIFF'); ascii(v, 8, 'WAVE'); ascii(v, 12, 'fmt '); ascii(v, 36, 'data');
    expect(v.getUint32(16, true)).toBe(16); // fmt length
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(16000); // rate
    expect(v.getUint32(28, true)).toBe(32000); // byte rate
    expect(v.getUint16(32, true)).toBe(2); // block align
    expect(v.getUint16(34, true)).toBe(16); // bits
  });

  it('writes samples as clamped 16-bit little-endian', async () => {
    const v = await bytes(new Float32Array([0, 1, -1, 0.5, 2, -2]));
    const got = [0, 1, 2, 3, 4, 5].map((i) => v.getInt16(44 + i * 2, true));
    expect(got).toEqual([0, 32767, -32767, 16383, 32767, -32767]);
  });

  it('honours a non-default rate, and an empty body is a header alone', async () => {
    const v = await bytes(new Float32Array([0, 0]), 8000);
    expect(v.getUint32(24, true)).toBe(8000);
    expect(v.getUint32(28, true)).toBe(16000);
    const empty = await bytes(new Float32Array([]));
    expect(empty.byteLength).toBe(44);
    expect(empty.getUint32(40, true)).toBe(0);
  });
});
