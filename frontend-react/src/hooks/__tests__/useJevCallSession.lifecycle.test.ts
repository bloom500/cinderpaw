import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// The speaker is not what these tests are about, and it listens to the host.
vi.mock('../useSpeechPlayer', () => ({
  useSpeechPlayer: () => ({ beginSpeech: vi.fn(async () => {}), feedSpeech: vi.fn(), endSpeech: vi.fn(async () => {}), stop: vi.fn() }),
}));

import { useJevCallSession } from '../useJevCallSession';

/** Resolves or rejects the pending `getUserMedia`, so a test owns the permission prompt. */
let grant: ((s: MediaStream) => void) | null = null;
let refuse: ((e: unknown) => void) | null = null;

function fakeStream() {
  const track = { stop: vi.fn(), enabled: true };
  return { track, stream: { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream };
}

beforeEach(() => {
  grant = null;
  refuse = null;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(() => new Promise<MediaStream>((res, rej) => { grant = res; refuse = rej; })),
    },
  });
});

afterEach(() => vi.restoreAllMocks());

describe('a Jev call ended while the microphone is being asked for', () => {
  it('stays ended, and the microphone it was granted is let go', async () => {
    const { result } = renderHook(() => useJevCallSession(async () => {}));
    act(() => result.current.open());
    act(() => { void result.current.begin(); });
    expect(result.current.phase).toBe('connecting');
    act(() => result.current.hangUp());
    const { stream, track } = fakeStream();
    await act(async () => { grant!(stream); await Promise.resolve(); });
    expect(result.current.phase).toBe('idle');
    expect(track.stop).toHaveBeenCalled();
  });

  it('does not bring the pre-call screen back when the refusal lands after the hang-up', async () => {
    const { result } = renderHook(() => useJevCallSession(async () => {}));
    act(() => result.current.open());
    act(() => { void result.current.begin(); });
    act(() => result.current.hangUp());
    await act(async () => { refuse!(new DOMException('denied', 'NotAllowedError')); await Promise.resolve(); });
    expect(result.current.phase).toBe('idle');
    expect(result.current.notice).toBeNull();
  });

  it('says a refused microphone in words, not as an exception', async () => {
    const { result } = renderHook(() => useJevCallSession(async () => {}));
    act(() => result.current.open());
    act(() => { void result.current.begin(); });
    await act(async () => { refuse!(new DOMException('denied', 'NotAllowedError')); await Promise.resolve(); });
    expect(result.current.phase).toBe('ready');
    expect(result.current.notice).toMatch(/microphone was refused/);
  });
});
