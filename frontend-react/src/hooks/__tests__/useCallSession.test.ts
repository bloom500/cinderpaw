import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const speech = vi.hoisted(() => ({
  beginSpeech: vi.fn(async () => {}),
  feedSpeech: vi.fn(),
  endSpeech: vi.fn(async () => 0),
  stop: vi.fn(),
  isPlaying: vi.fn(() => false),
}));

const stopActiveStream = vi.hoisted(() => vi.fn(async () => {}));
const chat = vi.hoisted(() => ({
  stream: vi.fn(async () => {}),
  cloudStream: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
}));
const listen = vi.hoisted(() => vi.fn(async () => () => {}));
const transcribeVoiceBlob = vi.hoisted(() => vi.fn(async () => 'voice turn'));
let analyserLevel = 0;

vi.mock('../useSpeechPlayer', () => ({ useSpeechPlayer: () => speech }));
vi.mock('../useSendMessage', () => ({
  saveVoiceBlobToDisk: vi.fn(async () => 'voice.webm'),
  transcribeVoiceBlob,
}));
vi.mock('@/lib/voiceModel', () => ({ ensureWhisperModel: vi.fn(async () => {}) }));
vi.mock('@/lib/streamControl', () => ({ stopActiveStream }));
vi.mock('@/lib/tauri', () => ({
  tauri: {
    raw: { uiLog: vi.fn(async () => {}) },
    chat,
  },
  events: {
    tokenEvent: { listen },
    streamDoneEvent: { listen },
    streamErrorEvent: { listen },
    streamTruncatedEvent: { listen },
    streamStartEvent: { listen },
    streamUsageEvent: { listen },
  },
}));

import { useCallSession } from '../useCallSession';
import { requestStreamStop, startChatStream } from '@/lib/chatStream';
import { useChat } from '@/stores/chat';

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  state: RecordingState = 'inactive';

  constructor(_stream: MediaStream) {
    FakeRecorder.instances.push(this);
  }

  start() { this.state = 'recording'; }

  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    this.onstop?.();
  }
}

class FakeAudioContext {
  state: AudioContextState = 'running';
  createAnalyser() {
    return {
      fftSize: 1024,
      getFloatTimeDomainData: (frame: Float32Array) => frame.fill(analyserLevel),
    } as unknown as AnalyserNode;
  }
  createMediaStreamSource() { return { connect: vi.fn() } as unknown as MediaStreamAudioSourceNode; }
  close() { return Promise.resolve(); }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function mediaStream() {
  const stop = vi.fn();
  return {
    stream: { getTracks: () => [{ stop }] } as unknown as MediaStream,
    stop,
  };
}

async function startTypedTurn(send: (text: string) => Promise<void>) {
  const mic = mediaStream();
  vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce(mic.stream);
  const hook = renderHook(() => useCallSession(send));

  act(() => hook.result.current.open());
  await act(async () => { await hook.result.current.begin(); });
  await waitFor(() => expect(hook.result.current.phase).toBe('listening'));
  act(() => hook.result.current.say('first turn'));

  return { ...hook, mic };
}

beforeEach(() => {
  vi.clearAllMocks();
  FakeRecorder.instances = [];
  analyserLevel = 0;
  Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: FakeRecorder });
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FakeAudioContext });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn() },
  });
  useChat.setState({ messages: [], sessionId: 'call-test', streamStatus: 'idle' });
});

describe('chat stream stop requested before registration', () => {
  it('consumes the stop instead of starting the stale generation', async () => {
    await requestStreamStop('not-registered-yet');
    const handlers = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      onStopped: vi.fn(),
    };

    await startChatStream(
      'not-registered-yet',
      [],
      { temperature: 0.7, top_p: 0.9, repeat_penalty: 1.1, max_tokens: 100 },
      null,
      handlers,
    );

    expect(handlers.onStopped).toHaveBeenCalledOnce();
    expect(chat.stream).not.toHaveBeenCalled();
  });
});

describe('useCallSession turn generation', () => {
  it('closes a getUserMedia result superseded by a newer begin', async () => {
    const first = deferred<MediaStream>();
    const second = deferred<MediaStream>();
    const firstMic = mediaStream();
    const secondMic = mediaStream();
    vi.mocked(navigator.mediaDevices.getUserMedia)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useCallSession(async () => {}));
    act(() => result.current.open());

    let firstBegin!: Promise<void>;
    let secondBegin!: Promise<void>;
    act(() => {
      firstBegin = result.current.begin();
      secondBegin = result.current.begin();
    });
    second.resolve(secondMic.stream);
    await act(async () => { await secondBegin; });
    first.resolve(firstMic.stream);
    await act(async () => { await firstBegin; });

    expect(firstMic.stop).toHaveBeenCalledOnce();
    act(() => result.current.hangUp());
    expect(secondMic.stop).toHaveBeenCalledOnce();
  });

  it('ignores a stale getUserMedia rejection after a newer begin succeeds', async () => {
    const first = deferred<MediaStream>();
    const second = deferred<MediaStream>();
    const secondMic = mediaStream();
    vi.mocked(navigator.mediaDevices.getUserMedia)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result, unmount } = renderHook(() => useCallSession(async () => {}));
    act(() => result.current.open());

    let firstBegin!: Promise<void>;
    let secondBegin!: Promise<void>;
    act(() => {
      firstBegin = result.current.begin();
      secondBegin = result.current.begin();
    });
    second.resolve(secondMic.stream);
    await act(async () => { await secondBegin; });
    await waitFor(() => expect(result.current.phase).toBe('listening'));

    first.reject(new Error('stale permission failure'));
    await act(async () => { await firstBegin; });

    expect(result.current.phase).toBe('listening');
    act(() => result.current.hangUp());
    unmount();
  });

  it('stops speech that rearms after its turn was abandoned', async () => {
    const speechReady = deferred<void>();
    speech.beginSpeech.mockReturnValueOnce(speechReady.promise);
    const { result, unmount } = await startTypedTurn(vi.fn(async () => {}));
    await waitFor(() => expect(speech.beginSpeech).toHaveBeenCalledOnce());

    act(() => result.current.hangUp());
    speech.stop.mockClear();
    speechReady.resolve();
    await act(async () => { await speechReady.promise; });

    expect(speech.stop).toHaveBeenCalledOnce();
    unmount();
  });

  it('does not hand a closed call capture to the next call', async () => {
    const pending = deferred<void>();
    const { result, unmount } = await startTypedTurn(vi.fn(() => pending.promise));
    const capture = FakeRecorder.instances.at(-1)!;

    await new Promise((resolve) => setTimeout(resolve, 500));
    analyserLevel = 0.24;
    await waitFor(() => expect(stopActiveStream).toHaveBeenCalledOnce(), { timeout: 2_000 });
    capture.ondataavailable?.({ data: new Blob(['old call']) });
    act(() => result.current.hangUp());
    await waitFor(() => expect(capture.state).toBe('inactive'));

    transcribeVoiceBlob.mockClear();
    analyserLevel = 0;
    const nextMic = mediaStream();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce(nextMic.stream);
    act(() => result.current.open());
    await act(async () => { await result.current.begin(); });
    await waitFor(() => expect(result.current.phase).toBe('listening'));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(transcribeVoiceBlob).not.toHaveBeenCalled();
    act(() => result.current.hangUp());
    unmount();
  });

  it('does not let a stopped send continuation leave listening', async () => {
    const pending = deferred<void>();
    const send = vi.fn(() => pending.promise);
    const { result, unmount } = await startTypedTurn(send);
    await waitFor(() => expect(send).toHaveBeenCalledOnce());

    act(() => result.current.interrupt());
    await waitFor(() => expect(result.current.phase).toBe('listening'));
    pending.resolve();
    await act(async () => { await Promise.resolve(); });

    expect(result.current.phase).toBe('listening');
    unmount();
  });

  it('does not let a send continuation resurrect a hung-up call', async () => {
    const pending = deferred<void>();
    const send = vi.fn(() => pending.promise);
    const { result, unmount } = await startTypedTurn(send);
    await waitFor(() => expect(send).toHaveBeenCalledOnce());

    act(() => result.current.hangUp());
    pending.resolve();
    await act(async () => { await Promise.resolve(); });

    expect(result.current.phase).toBe('idle');
    unmount();
  });

  it('keeps the barge-in recorder open until trailing silence', async () => {
    const pending = deferred<void>();
    const send = vi.fn(() => pending.promise);
    const { result, unmount } = await startTypedTurn(send);
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    const capture = FakeRecorder.instances.at(-1)!;

    await new Promise((resolve) => setTimeout(resolve, 500));
    analyserLevel = 0.24;
    await waitFor(() => expect(stopActiveStream).toHaveBeenCalledOnce(), { timeout: 2_000 });

    expect(capture.state).toBe('recording');
    analyserLevel = 0;
    await waitFor(() => expect(capture.state).toBe('inactive'), { timeout: 2_000 });

    act(() => result.current.hangUp());
    unmount();
  });

  it('settles a tripped capture when its input stream stops', async () => {
    const pending = deferred<void>();
    const send = vi.fn(() => pending.promise);
    const { result, unmount } = await startTypedTurn(send);
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    const capture = FakeRecorder.instances.at(-1)!;

    await new Promise((resolve) => setTimeout(resolve, 500));
    analyserLevel = 0.24;
    await waitFor(() => expect(stopActiveStream).toHaveBeenCalledOnce(), { timeout: 2_000 });

    act(() => capture.stop());
    await waitFor(() => expect(result.current.phase).toBe('listening'), { timeout: 2_000 });

    act(() => result.current.hangUp());
    unmount();
  });

  it('reports a muted microphone after a full silent recording', async () => {
    vi.useFakeTimers();
    try {
      const mic = mediaStream();
      vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce(mic.stream);
      const { result, unmount } = renderHook(() => useCallSession(vi.fn(async () => {})));

      act(() => result.current.open());
      await act(async () => { await result.current.begin(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(8_100); });

      expect(result.current.notice).toBe('No microphone signal detected. Check your input device or mute setting.');
      act(() => result.current.hangUp());
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects playback residue captured by the next recording', async () => {
    const reply = 'Playback residue phrase from the speaker.';
    transcribeVoiceBlob.mockResolvedValueOnce(reply);
    const send = vi.fn(async () => {
      useChat.setState({
        messages: [{ id: 'assistant-1', role: 'assistant', content: reply, createdAt: Date.now() }],
        streamStatus: 'done',
      });
    });
    const { result, unmount } = await startTypedTurn(send);
    await waitFor(() => expect(speech.endSpeech).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.phase).toBe('listening'));

    analyserLevel = 0.08;
    await new Promise((resolve) => setTimeout(resolve, 400));
    analyserLevel = 0;
    await waitFor(() => expect(transcribeVoiceBlob).toHaveBeenCalledOnce(), { timeout: 2_000 });
    await waitFor(() => expect(result.current.phase).toBe('listening'));

    expect(send).toHaveBeenCalledOnce();
    act(() => result.current.hangUp());
    unmount();
  });
});
