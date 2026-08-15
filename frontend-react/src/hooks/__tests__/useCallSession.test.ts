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

vi.mock('../useSpeechPlayer', () => ({ useSpeechPlayer: () => speech }));
vi.mock('../useSendMessage', () => ({
  saveVoiceBlobToDisk: vi.fn(async () => 'voice.webm'),
  transcribeVoiceBlob: vi.fn(async () => 'voice turn'),
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
      getFloatTimeDomainData: (frame: Float32Array) => frame.fill(0),
    } as unknown as AnalyserNode;
  }
  createMediaStreamSource() { return { connect: vi.fn() } as unknown as MediaStreamAudioSourceNode; }
  close() { return Promise.resolve(); }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
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
});
