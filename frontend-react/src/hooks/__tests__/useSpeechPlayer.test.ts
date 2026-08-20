import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stopSpeaking = vi.hoisted(() => vi.fn(async () => {}));
const listen = vi.hoisted(() => vi.fn(async () => vi.fn()));

vi.mock('@/lib/tauri', () => ({
  tauri: {
    raw: { uiLog: vi.fn(async () => {}) },
    voice: {
      speak: vi.fn(async () => 0),
      stopSpeaking,
    },
  },
}));

vi.mock('@/lib/tauri/events', () => ({
  events: { ttsChunkEvent: { listen } },
}));

import { useSpeechPlayer } from '../useSpeechPlayer';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useSpeechPlayer cleanup', () => {
  it('stops backend synthesis when the owner unmounts', () => {
    const { unmount } = renderHook(() => useSpeechPlayer('call-session'));

    unmount();

    expect(stopSpeaking).toHaveBeenCalledWith('call-session');
  });
});
