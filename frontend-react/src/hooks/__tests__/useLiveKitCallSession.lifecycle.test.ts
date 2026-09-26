import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

/**
 * A Room that connects only when a test says so.
 *
 * Hoisted by `vi.mock`, so it cannot close over anything declared below. The
 * handles it needs live on the mock module itself and are imported back.
 */
vi.mock('livekit-client', () => {
  const rooms: FakeRoom[] = [];
  let connectImpl: () => Promise<void> = () => Promise.resolve();
  class FakeRoom {
    handlers = new Map<string, ((...a: unknown[]) => void)[]>();
    localParticipant = {
      setMicrophoneEnabled: vi.fn(async () => {}),
      publishData: vi.fn(async () => {}),
      audioTrackPublications: new Map(),
    };
    constructor() {
      rooms.push(this);
    }
    on(ev: string, cb: (...a: unknown[]) => void) {
      const list = this.handlers.get(ev) ?? [];
      list.push(cb);
      this.handlers.set(ev, list);
      return this;
    }
    connect() {
      return connectImpl();
    }
    disconnect() {
      return Promise.resolve();
    }
    /** Fire a room event the way livekit-client would. */
    __fire(ev: string, ...args: unknown[]) {
      for (const cb of this.handlers.get(ev) ?? []) cb(...args);
    }
  }
  return {
    Room: FakeRoom,
    RoomEvent: {
      TrackSubscribed: 'trackSubscribed',
      Disconnected: 'disconnected',
      Reconnecting: 'reconnecting',
      Reconnected: 'reconnected',
      ParticipantDisconnected: 'participantDisconnected',
    },
    Track: { Kind: { Audio: 'audio' } },
    __lastRoom: () => rooms[rooms.length - 1],
    __setConnect: (fn: () => Promise<void>) => {
      connectImpl = fn;
    },
  };
});

import { useLiveKitCallSession } from '../useLiveKitCallSession';
import { events, type LiveKitAgentEvent } from '@/lib/tauri/events';
import { tauri } from '@/lib/tauri';
import { useChat } from '@/stores/chat';

/* eslint-disable @typescript-eslint/no-explicit-any */
const lk = (await import('livekit-client')) as any;
const lastRoom = () => lk.__lastRoom() as { __fire: (e: string, ...a: unknown[]) => void };
const setConnect = lk.__setConnect as (fn: () => Promise<void>) => void;

/**
 * The call's lifecycle, driven from the button rather than from the transcript.
 *
 * Everything below the hook is faked on purpose. A Room that never connects
 * until the test says so is the only way to observe the window between the
 * press and the connection, and that window is where every complaint about
 * "the call takes twenty seconds" actually lives.
 */

let emit: ((e: LiveKitAgentEvent) => void) | null = null;
/** Resolves the pending `start_livekit_call`, so a test owns the boot's length. */
let releaseStart: ((v: unknown) => void) | null = null;
/** Resolves the pending `room.connect`. */
let releaseConnect: (() => void) | null = null;

const CALL = { url: 'ws://127.0.0.1:1', token: 't', room: 'r', mode: 'assistant' };

beforeEach(() => {
  emit = null;
  releaseStart = null;
  releaseConnect = null;
  useChat.setState({ messages: [] });
  vi.spyOn(events.liveKitEvent, 'listen').mockImplementation((cb) => {
    emit = cb;
    return Promise.resolve(() => {});
  });
  vi.spyOn(tauri.raw, 'startLivekitCall').mockImplementation(
    () => new Promise((res) => { releaseStart = res as (v: unknown) => void; }) as any,
  );
  vi.spyOn(tauri.raw, 'endLivekitCall').mockResolvedValue(undefined as any);
  vi.spyOn(tauri.raw, 'warmLivekit').mockResolvedValue(undefined as any);
  setConnect(() => new Promise<void>((res) => { releaseConnect = res; }));
});

afterEach(() => vi.restoreAllMocks());

describe('old rooms cannot control a replacement call', () => {
  it('ignores reconnect and disconnect events after hanging up an old room', async () => {
    const { result } = renderHook(() => useLiveKitCallSession());
    await connectFully(result);
    const old = lastRoom();
    act(() => result.current.hangUp());
    await connectFully(result);
    const ends = vi.mocked(tauri.raw.endLivekitCall).mock.calls.length;
    act(() => old.__fire('reconnecting'));
    expect(result.current.phase).toBe('listening');
    act(() => old.__fire('disconnected'));
    expect(result.current.phase).toBe('listening');
    expect(tauri.raw.endLivekitCall).toHaveBeenCalledTimes(ends);
  });

  it('does not let a stale connection failure tear down the next call', async () => {
    let rejectOld!: (error: Error) => void;
    setConnect(() => new Promise<void>((_resolve, reject) => { rejectOld = reject; }));
    const { result } = renderHook(() => useLiveKitCallSession());
    act(() => { void result.current.begin(); });
    await act(async () => { releaseStart!(CALL); });
    act(() => result.current.hangUp());
    setConnect(() => Promise.resolve());
    act(() => { void result.current.begin(); });
    await act(async () => { releaseStart!(CALL); });
    expect(result.current.phase).toBe('listening');
    await act(async () => { rejectOld(new Error('old connection failed')); });
    expect(result.current.phase).toBe('listening');
    expect(result.current.notice).toBeNull();
  });

  it('disconnects the room when microphone acquisition fails', async () => {
    const { result } = renderHook(() => useLiveKitCallSession());
    act(() => { void result.current.begin(); });
    await act(async () => { releaseStart!(CALL); });
    const r = lk.__lastRoom();
    const disconnect = vi.spyOn(r, 'disconnect');
    r.localParticipant.setMicrophoneEnabled.mockRejectedValueOnce(new Error('Permission denied'));
    await act(async () => { releaseConnect!(); });
    expect(result.current.phase).toBe('ready');
    expect(disconnect).toHaveBeenCalledOnce();
  });
});

describe('a session the agent closed is over for the window too', () => {
  it('leaves the room, ends the host call and shows the reason', async () => {
    const { result } = renderHook(() => useLiveKitCallSession());
    await connectFully(result);
    const r = lk.__lastRoom();
    const disconnect = vi.spyOn(r, 'disconnect');
    const ends = vi.mocked(tauri.raw.endLivekitCall).mock.calls.length;
    // The 17 Sep shape: the vendor refused audio, the session closed, and the
    // orb kept listening in front of nothing (Astra, 19 Sep 2026, P5).
    act(() => emit!({ kind: 'closed', text: 'CONTENT_TYPE_AUDIO is not supported' }));
    expect(disconnect).toHaveBeenCalledOnce();
    expect(tauri.raw.endLivekitCall).toHaveBeenCalledTimes(ends + 1);
    expect(result.current.phase).toBe('ready');
    expect(result.current.notice).toBeTruthy();
    // A second close (the worker dying after our hang-up) is not a second end.
    act(() => emit!({ kind: 'closed', text: '' }));
    expect(tauri.raw.endLivekitCall).toHaveBeenCalledTimes(ends + 1);
  });

  it('relays a late tool answer to the worker over the data channel', async () => {
    const { result } = renderHook(() => useLiveKitCallSession());
    await connectFully(result);
    const r = lk.__lastRoom();
    act(() => emit!({ kind: 'toolLate', id: 'v-3', text: 'sunny, 21 degrees' }));
    const sent = r.localParticipant.publishData.mock.calls.map((c: unknown[]) =>
      JSON.parse(new TextDecoder().decode(c[0] as Uint8Array)),
    );
    expect(sent).toContainEqual({ type: 'toolLate', id: 'v-3', text: 'sunny, 21 degrees' });
  });
});

/** Press Call and let the boot and the room join both complete. */
async function connectFully(result: { current: ReturnType<typeof useLiveKitCallSession> }) {
  act(() => { void result.current.begin(); });
  await act(async () => { releaseStart!(CALL); await Promise.resolve(); });
  await waitFor(() => expect(releaseConnect).toBeTruthy());
  await act(async () => { releaseConnect!(); await Promise.resolve(); });
  await waitFor(() => expect(result.current.phase).toBe('listening'));
}

describe('pressing Call is answered on screen before it is answered by the backend', () => {
  it('leaves the pre-call state the moment the button is pressed', async () => {
    const { result } = renderHook(() => useLiveKitCallSession());
    await waitFor(() => expect(emit).toBeTruthy());
    act(() => result.current.open());
    expect(result.current.phase).toBe('ready');

    // The press. Nothing has been awaited yet: no server, no room, no
    // microphone. What the person must NOT see is the same screen with the
    // same button, which is what a call that takes fifteen seconds looks like
    // when nothing changes state until it connects.
    act(() => { void result.current.begin(); });
    expect(result.current.phase).toBe('connecting');
  });

  it('says which stage the connection has reached, not only that it is busy', async () => {
    const { result } = renderHook(() => useLiveKitCallSession());
    await waitFor(() => expect(emit).toBeTruthy());
    act(() => result.current.open());
    act(() => { void result.current.begin(); });

    // Fifteen seconds of one undifferentiated spinner is indistinguishable
    // from a hang. The stages are already known here; naming them costs
    // nothing and is the difference between waiting and wondering.
    expect(result.current.stage).toBe('starting');
    await act(async () => { releaseStart!(CALL); await Promise.resolve(); });
    await waitFor(() => expect(result.current.stage).toBe('joining'));
  });
});

describe('a call that is cancelled while it is connecting', () => {
  it('leaves the button usable instead of dead until the old boot finishes', async () => {
    const { result } = renderHook(() => useLiveKitCallSession());
    await waitFor(() => expect(emit).toBeTruthy());
    act(() => result.current.open());
    act(() => { void result.current.begin(); });

    // Somebody changes their mind during the wait, then tries again. The first
    // `begin` is still parked on a boot that can take fifteen seconds; if the
    // re-entry guard is still held by it, the second press does nothing at all
    // and the only visible fact is a button that no longer works.
    act(() => result.current.hangUp());
    act(() => result.current.open());
    act(() => { void result.current.begin(); });

    expect(result.current.phase).toBe('connecting');
    expect(tauri.raw.startLivekitCall).toHaveBeenCalledTimes(2);
  });
});

describe('the room dropping out mid-call', () => {
  it('says it is reconnecting instead of continuing to claim it is listening', async () => {
    const { result } = renderHook(() => useLiveKitCallSession());
    await waitFor(() => expect(emit).toBeTruthy());
    act(() => result.current.open());
    await connectFully(result);

    // LiveKit retries on its own and only reports `Disconnected` once it has
    // given up. Between those two the app was telling the person it was
    // listening to them, which it was not.
    act(() => lastRoom().__fire('reconnecting'));
    expect(result.current.phase).toBe('reconnecting');

    act(() => lastRoom().__fire('reconnected'));
    expect(result.current.phase).toBe('listening');
  });
});

describe('the ways a call can fail', () => {
  it('turns a refused microphone into a sentence and leaves the call retryable', async () => {
    const { result } = renderHook(() => useLiveKitCallSession());
    await waitFor(() => expect(emit).toBeTruthy());
    act(() => result.current.open());
    act(() => { void result.current.begin(); });
    await act(async () => { releaseStart!(CALL); await Promise.resolve(); });
    // The permission prompt is answered after the room is joined, so this is
    // the one failure that arrives with a live room already in hand. Armed
    // here, while the room exists and the join has not resolved.
    await waitFor(() => expect(releaseConnect).toBeTruthy());
    lk.__lastRoom().localParticipant.setMicrophoneEnabled.mockRejectedValueOnce(
      new Error('Permission denied'),
    );
    await act(async () => { releaseConnect!(); await Promise.resolve(); });

    await waitFor(() => expect(result.current.notice).toMatch(/microphone was refused/i));
    // Back on the screen that has the button, not stuck on a spinner.
    expect(result.current.phase).toBe('ready');
    expect(result.current.stage).toBeNull();
  });

  it('lets the next call start after one that failed', async () => {
    const { result } = renderHook(() => useLiveKitCallSession());
    await waitFor(() => expect(emit).toBeTruthy());
    act(() => result.current.open());
    act(() => { void result.current.begin(); });
    await act(async () => {
      releaseStart = null;
      // The boot itself fails: no Node, no server, a taken port.
      vi.mocked(tauri.raw.startLivekitCall).mockRejectedValueOnce(new Error('livekit-no-node'));
      await Promise.resolve();
    });
    // Drive the first attempt to its failure, then try again.
    act(() => { void result.current.begin(); });
    await waitFor(() => expect(result.current.phase).toBe('connecting'));
    expect(result.current.phase).not.toBe('idle');
  });

  it('refuses a second call on top of a live one', async () => {
    const { result } = renderHook(() => useLiveKitCallSession());
    await waitFor(() => expect(emit).toBeTruthy());
    act(() => result.current.open());
    await connectFully(result);
    const before = vi.mocked(tauri.raw.startLivekitCall).mock.calls.length;

    // Two rooms means two agents means two voices answering one question,
    // which is exactly the bug the re-entry guard exists for.
    act(() => { void result.current.begin(); });
    expect(vi.mocked(tauri.raw.startLivekitCall).mock.calls.length).toBe(before);
    expect(result.current.phase).toBe('listening');
  });

  it('does not leave an agent running when the call is abandoned mid-boot', async () => {
    const { result } = renderHook(() => useLiveKitCallSession());
    await waitFor(() => expect(emit).toBeTruthy());
    act(() => result.current.open());
    act(() => { void result.current.begin(); });
    act(() => result.current.hangUp());
    // Rust has already minted a room and dispatched an agent by now. Leaving
    // without saying so keeps that agent alive in a room nobody joins, holding
    // a vendor session open and, on a metered key, billing for silence.
    await act(async () => { releaseStart!(CALL); await Promise.resolve(); });
    await waitFor(() => expect(tauri.raw.endLivekitCall).toHaveBeenCalled());
    expect(result.current.phase).toBe('idle');
  });
});

describe('a call that ends on its own leaves nothing behind for the next one', () => {
  it('starts the next call unmuted after one that closed while muted', async () => {
    const { result } = renderHook(() => useLiveKitCallSession());
    await waitFor(() => expect(emit).toBeTruthy());
    await connectFully(result);
    act(() => result.current.setMuted(true));
    expect(result.current.muted).toBe(true);
    // The vendor ends it: no hang-up from this side.
    act(() => emit!({ kind: 'closed', text: '429 RESOURCE_EXHAUSTED' } as LiveKitAgentEvent));
    expect(result.current.phase).toBe('ready');
    await connectFully(result);
    // The new room's microphone is live; the screen must not say otherwise.
    expect(result.current.muted).toBe(false);
  });

  it('shows the caller\'s new sentence instead of the last answer', async () => {
    const { result } = renderHook(() => useLiveKitCallSession());
    await waitFor(() => expect(emit).toBeTruthy());
    await connectFully(result);
    act(() => emit!({ kind: 'heard', text: 'what time is it', partial: false } as LiveKitAgentEvent));
    act(() => emit!({ kind: 'said', text: 'It is five.' } as LiveKitAgentEvent));
    expect(result.current.said).toBe('It is five.');
    act(() => emit!({ kind: 'heard', text: 'and in Tokyo', partial: true } as LiveKitAgentEvent));
    expect(result.current.said).toBe('');
    expect(result.current.heard).toBe('and in Tokyo');
  });

  it('keeps the answer when the final transcript of its question lands after it', async () => {
    const { result } = renderHook(() => useLiveKitCallSession());
    await waitFor(() => expect(emit).toBeTruthy());
    await connectFully(result);
    act(() => emit!({ kind: 'said', text: 'It is five.' } as LiveKitAgentEvent));
    act(() => emit!({ kind: 'heard', text: 'what time is it', partial: false } as LiveKitAgentEvent));
    expect(result.current.said).toBe('It is five.');
  });

  it('ends the call when the agent leaves the room without a close', async () => {
    const { result } = renderHook(() => useLiveKitCallSession());
    await waitFor(() => expect(emit).toBeTruthy());
    await connectFully(result);
    // Only now: `waitFor` above runs on the real clock.
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const ends = vi.mocked(tauri.raw.endLivekitCall).mock.calls.length;
      act(() => lastRoom().__fire('participantDisconnected', { isAgent: true }));
      // Not at once: a clean close sends its reason first, over another pipe.
      expect(result.current.phase).toBe('listening');
      act(() => { vi.advanceTimersByTime(2000); });
      expect(result.current.phase).toBe('ready');
      expect(result.current.notice).toMatch(/stopped unexpectedly/);
      expect(vi.mocked(tauri.raw.endLivekitCall).mock.calls.length).toBe(ends + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a close that arrives within the grace keep its own reason', async () => {
    const { result } = renderHook(() => useLiveKitCallSession());
    await waitFor(() => expect(emit).toBeTruthy());
    await connectFully(result);
    // Only now: `waitFor` above runs on the real clock.
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      act(() => lastRoom().__fire('participantDisconnected', { isAgent: true }));
      act(() => emit!({ kind: 'closed', text: 'CONTENT_TYPE_AUDIO is not supported for this model' } as LiveKitAgentEvent));
      act(() => { vi.advanceTimersByTime(2000); });
      expect(result.current.phase).toBe('ready');
      expect(result.current.notice).toMatch(/cannot speak/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a person, not the agent, leaving the room', async () => {
    const { result } = renderHook(() => useLiveKitCallSession());
    await waitFor(() => expect(emit).toBeTruthy());
    await connectFully(result);
    // Only now: `waitFor` above runs on the real clock.
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      act(() => lastRoom().__fire('participantDisconnected', { isAgent: false }));
      act(() => { vi.advanceTimersByTime(2000); });
      expect(result.current.phase).toBe('listening');
    } finally {
      vi.useRealTimers();
    }
  });
});
