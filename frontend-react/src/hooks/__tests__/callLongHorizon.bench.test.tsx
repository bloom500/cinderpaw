import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, act, waitFor } from '@testing-library/react';
import { useLiveKitCallSession } from '../useLiveKitCallSession';
import { events, type LiveKitAgentEvent } from '@/lib/tauri/events';
import { useChat } from '@/stores/chat';

/**
 * Does a call get slower the longer it lasts, on OUR side of it?
 *
 * The complaint is that a transcript appears later and later as a conversation
 * goes on. That has several possible homes: the vendor's context, the local
 * model's prefill, the IPC, the store, the render. This measures the two that
 * are ours and are reachable without a live call, at 1, 10, 25, 50 and 100
 * turns, so the answer to "is it React" is a number rather than a guess.
 *
 * The assertions are deliberately loose. The point is to catch a cost that
 * GROWS WITH THE CONVERSATION, not to police milliseconds on a busy machine:
 * a per-turn cost that is flat at 100 turns is flat whatever the constant is.
 */

let emit: ((e: LiveKitAgentEvent) => void) | null = null;

beforeEach(() => {
  emit = null;
  useChat.setState({ messages: [] });
  vi.spyOn(events.liveKitEvent, 'listen').mockImplementation((cb) => {
    emit = cb;
    return Promise.resolve(() => {});
  });
});
afterEach(() => vi.restoreAllMocks());

const CHECKPOINTS = [1, 10, 25, 50, 100];

/** Median, so one scheduler hiccup does not become the measurement. */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/** The cost of one turn measured at each checkpoint along a 100-turn call. */
function walk(turn: (n: number) => void): Map<number, number> {
  const out = new Map<number, number>();
  for (let n = 1; n <= 100; n++) {
    const runs: number[] = [];
    // Only the checkpoints are timed; the rest just make the conversation long.
    if (CHECKPOINTS.includes(n)) {
      const t = performance.now();
      turn(n);
      runs.push(performance.now() - t);
      out.set(n, median(runs));
    } else {
      turn(n);
    }
  }
  return out;
}

describe('a call that has been going for a hundred turns', () => {
  it('costs the same per turn in the transcript path as it did at turn one', async () => {
    const { result } = renderHook(() => useLiveKitCallSession());
    await waitFor(() => expect(emit).toBeTruthy());
    expect(result.current.phase).toBe('idle');

    const costs = walk((n) => {
      act(() => {
        // A real turn: a few partials while somebody speaks, the final, then
        // the answer. Partials are the hot path, because they arrive several
        // times a second for as long as anybody is talking.
        emit!({ kind: 'heard', text: `turn ${n} par`, partial: true });
        emit!({ kind: 'heard', text: `turn ${n} partial tex`, partial: true });
        emit!({ kind: 'heard', text: `turn ${n} question`, partial: false });
        emit!({ kind: 'said', text: `answer to turn ${n}` });
      });
    });

    for (const [n, ms] of costs) console.log(`transcript path, turn ${n}: ${ms.toFixed(2)} ms`);
    expect(useChat.getState().messages).toHaveLength(200);
    // Ten times the first turn is a generous ceiling that still fails loudly on
    // anything that walks the whole conversation per event.
    expect(costs.get(100)!).toBeLessThan(Math.max(costs.get(1)!, 1) * 10);
  });

  it('costs the same per turn to render the conversation beside the call', async () => {
    // The panel's own subscription, reproduced: every new turn re-renders every
    // message, because the list is neither keyed off a window nor virtualised.
    function Panel() {
      const messages = useChat((s) => s.messages);
      return (
        <div>
          {messages.map((m) => (
            <p key={m.id}>{m.content}</p>
          ))}
        </div>
      );
    }
    render(<Panel />);

    let seq = 0;
    const costs = walk((n) => {
      act(() => {
        useChat.getState().addMessage({
          id: `u-${++seq}`,
          role: 'user',
          content: `turn ${n} question`,
          createdAt: Date.now(),
        });
        useChat.getState().addMessage({
          id: `a-${++seq}`,
          role: 'assistant',
          content: `answer to turn ${n}`,
          createdAt: Date.now(),
        });
      });
    });

    for (const [n, ms] of costs) console.log(`conversation render, turn ${n}: ${ms.toFixed(2)} ms`);
    expect(costs.get(100)!).toBeLessThan(Math.max(costs.get(1)!, 1) * 20);
  });
});
