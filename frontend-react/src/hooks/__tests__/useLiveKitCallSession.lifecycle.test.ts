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
