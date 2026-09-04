import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useLiveKitCallSession } from '../useLiveKitCallSession';
import { useChat } from '@/stores/chat';
import { events, type LiveKitAgentEvent } from '@/lib/tauri/events';

/**
 * A call that leaves no trace is a call you cannot look anything up in
 * afterwards, and the wiring that prevents that is one listener deep — easy to
 * break, and invisible when broken until somebody hangs up and finds nothing.
 *
 * Driven by faking the event rather than by driving the app: the transcript
 * arrives from a Node process, through Rust, over a Tauri channel, and none of
 * those need to be running for "does this event become a message" to have a
 * definite answer.
 */

let emit: ((e: LiveKitAgentEvent) => void) | null = null;

beforeEach(() => {
  emit = null;
  vi.spyOn(events.liveKitEvent, 'listen').mockImplementation((cb) => {
    emit = cb;
    return Promise.resolve(() => {});
  });
  useChat.setState({ messages: [] });
});

afterEach(() => vi.restoreAllMocks());

describe('a spoken turn reaches the conversation', () => {
  it('writes both sides, in the order they were spoken', async () => {
    renderHook(() => useLiveKitCallSession());
    await waitFor(() => expect(emit).toBeTruthy());

    act(() => {
      emit!({ kind: 'heard', text: 'what did we decide about the mac build' });
      emit!({ kind: 'said', text: 'We build it from source in CI.' });
    });

    const written = useChat.getState().messages;
    expect(written.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(written[0]?.content).toBe('what did we decide about the mac build');
    expect(written[1]?.content).toBe('We build it from source in CI.');
  });

  it('gives two turns in the same millisecond distinct ids', async () => {
    renderHook(() => useLiveKitCallSession());
    await waitFor(() => expect(emit).toBeTruthy());

    // A React list keyed by a duplicate id silently drops one of the two, which
    // reads as a turn that was never said.
    act(() => {
      emit!({ kind: 'said', text: 'one' });
      emit!({ kind: 'said', text: 'two' });
    });

    const ids = useChat.getState().messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not write empty turns', async () => {
    renderHook(() => useLiveKitCallSession());
    await waitFor(() => expect(emit).toBeTruthy());

    act(() => {
      emit!({ kind: 'heard', text: '   ' });
      emit!({ kind: 'state', text: 'listening' });
      emit!({ kind: 'closed' });
    });

    expect(useChat.getState().messages).toHaveLength(0);
  });

  it('turns a quota refusal into a sentence with a next step', async () => {
    const { result } = renderHook(() => useLiveKitCallSession());
    await waitFor(() => expect(emit).toBeTruthy());

    act(() => {
      emit!({ kind: 'error', text: 'got status: 429 RESOURCE_EXHAUSTED', recoverable: false });
    });

    // The raw message names an HTTP status and a quota id, which tells a person
    // nothing about what to do — and a rate-limited call otherwise looks
    // exactly like the app breaking.
    expect(result.current.notice).toMatch(/free tier/i);
    expect(result.current.notice).toMatch(/wait a few minutes|billing/i);
  });
});
