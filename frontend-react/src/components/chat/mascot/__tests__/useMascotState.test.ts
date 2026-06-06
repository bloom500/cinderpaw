import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMascotState, DONE_HOLD_MS } from '../useMascotState';
import type { StreamStatus } from '@/stores/chat';
import type { AgentPhase } from '@/stores/chat';

function run(args: { streamStatus: StreamStatus; agentPhase: AgentPhase; isUserTyping: boolean }) {
  return renderHook((p: typeof args) => useMascotState(p), { initialProps: args });
}

describe('useMascotState', () => {
  it('idle when nothing is happening', () => {
    const { result } = run({ streamStatus: 'idle', agentPhase: null, isUserTyping: false });
    expect(result.current).toBe('idle');
  });

  it('typing when user has text and not streaming', () => {
    const { result } = run({ streamStatus: 'idle', agentPhase: null, isUserTyping: true });
    expect(result.current).toBe('typing');
  });

  it('thinking while streaming with no/thinking/processing phase', () => {
    for (const phase of [null, 'thinking', 'processing'] as AgentPhase[]) {
      const { result } = run({ streamStatus: 'streaming', agentPhase: phase, isUserTyping: false });
      expect(result.current).toBe('thinking');
    }
  });

  it('calling while streaming with calling phase', () => {
    const { result } = run({ streamStatus: 'streaming', agentPhase: 'calling', isUserTyping: false });
    expect(result.current).toBe('calling');
  });

  it('typing is ignored while streaming', () => {
    const { result } = run({ streamStatus: 'streaming', agentPhase: null, isUserTyping: true });
    expect(result.current).toBe('thinking');
  });

  describe('transient done', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('shows done then reverts to idle after DONE_HOLD_MS', () => {
      const { result, rerender } = run({ streamStatus: 'streaming', agentPhase: null, isUserTyping: false });
      act(() => {
        rerender({ streamStatus: 'done', agentPhase: null, isUserTyping: false });
      });
      expect(result.current).toBe('done');
      act(() => {
        vi.advanceTimersByTime(DONE_HOLD_MS + 50);
      });
      expect(result.current).toBe('idle');
    });
  });
});
