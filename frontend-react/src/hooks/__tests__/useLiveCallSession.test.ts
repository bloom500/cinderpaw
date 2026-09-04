import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChat } from '@/stores/chat';

type LiveEvent = { payload: { sessionId: string; kind: string; text: string } };

const liveListeners = vi.hoisted(() => new Set<(event: LiveEvent) => void>());
const unlisten = vi.hoisted(() => vi.fn());
const uiLog = vi.hoisted(() => vi.fn(async () => {}));
const startLiveCall = vi.hoisted(() => vi.fn(async () => {}));
const endLiveCall = vi.hoisted(() => vi.fn(async () => {}));
const sendLiveAudio = vi.hoisted(() => vi.fn(async () => {}));
const beginSpeech = vi.hoisted(() => vi.fn(async () => {}));
const stopSpeech = vi.hoisted(() => vi.fn());
const capture = vi.hoisted(() => ({
  callback: null as null | ((frame: Float32Array, loudness: number) => void),
  stop: vi.fn(),
}));

vi.mock('@/lib/tauri/events', () => ({
  events: {
    liveStatusEvent: {
      listen: vi.fn(async (callback: (event: LiveEvent) => void) => {
        liveListeners.add(callback);
        return () => {
          liveListeners.delete(callback);
          unlisten();
        };
      }),
    },
  },
}));

vi.mock('@/lib/tauri', () => ({
  tauri: {
    raw: {
      getLastTask: vi.fn(async () => null),
      startLiveCall,
      endLiveCall,
      sendLiveAudio,
      sendLiveText: vi.fn(async () => {}),
      uiLog,
    },
  },
}));

vi.mock('@/lib/micPcm', () => ({
  captureMicPcm: vi.fn(async (callback: (frame: Float32Array, loudness: number) => void) => {
    capture.callback = callback;
    return capture.stop;
  }),
  pcm16Base64: vi.fn(() => 'pcm'),
}));

vi.mock('@/stores/ui', () => ({
  useUI: { getState: () => ({ ttsVoice: {} }) },
}));

vi.mock('../useSpeechPlayer', () => ({
  useSpeechPlayer: () => ({ beginSpeech, stop: stopSpeech }),
}));

import { useLiveCallSession } from '../useLiveCallSession';

function emit(kind: string, text = '', sessionId = 'voice-session') {
  act(() => {
    for (const callback of liveListeners) callback({ payload: { sessionId, kind, text } });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  liveListeners.clear();
  capture.callback = null;
  useChat.setState({ sessionId: 'voice-session', messages: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useLiveCallSession transcript integrity', () => {
  it('commits one exact final pair and never stores interim fragments', () => {
    const { unmount } = renderHook(() => useLiveCallSession());

    emit('inputTranscript', 'Ana ');
    expect(useChat.getState().messages).toHaveLength(0);
    emit('inputTranscript', 'are ');
    expect(useChat.getState().messages).toHaveLength(0);
    emit('inputTranscript', 'mere');
    emit('outputTranscript', 'Da, are.');
    expect(useChat.getState().messages).toHaveLength(0);

    emit('turnComplete');
    expect(useChat.getState().messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: 'user', content: 'Ana are mere' },
      { role: 'assistant', content: 'Da, are.' },
    ]);

    emit('inputTranscript', 'A doua întrebare');
    emit('turnComplete');
    expect(useChat.getState().messages.at(-1)?.content).toBe('A doua întrebare');
    unmount();
  });

  it('ignores another session and never commits an unfinished closed turn', () => {
    const { unmount } = renderHook(() => useLiveCallSession());

    emit('inputTranscript', 'not ours', 'connector-session');
    emit('inputTranscript', 'unfinished');
    emit('closed', 'socket ended');

    expect(useChat.getState().messages).toEqual([]);
    unmount();
  });
});

describe('useLiveCallSession lifecycle', () => {
  it('never reports transcribing on a dead socket', async () => {
    const { result, unmount } = renderHook(() => useLiveCallSession());
    act(() => result.current.open());
    await act(async () => { await result.current.begin(); });

    act(() => capture.callback?.(new Float32Array([0.2]), 0.04));
    expect(result.current.transcribing).toBe(true);

    emit('closed');
    expect(result.current.phase).toBe('ready');
    expect(result.current.transcribing).toBe(false);
    expect(result.current.notice).toBe('Disconnected. Press call to reconnect.');
    unmount();
  });

  it('restores timers and listeners to baseline after hang-up and unmount', async () => {
    vi.useFakeTimers();
    const listenersBefore = liveListeners.size;
    const timersBefore = vi.getTimerCount();
    const { result, unmount } = renderHook(() => useLiveCallSession());

    expect(liveListeners.size).toBe(listenersBefore + 1);
    emit('inputTranscript', 'turn');
    emit('turnComplete');
    act(() => result.current.hangUp());

    expect(vi.getTimerCount()).toBe(timersBefore);
    unmount();
    await act(async () => {});
    expect(liveListeners.size).toBe(listenersBefore);
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
