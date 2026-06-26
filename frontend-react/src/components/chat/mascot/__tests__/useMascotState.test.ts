import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMascotState, DONE_HOLD_MS, COOL_HOLD_MS, EXCITED_HOLD_MS } from '../useMascotState';
import type { StreamStatus } from '@/stores/chat';
import type { AgentPhase } from '@/stores/chat';
import { useDream } from '@/stores/dream';

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

  describe('dreaming', () => {
    afterEach(() => useDream.getState().setDreaming(false));

    it('dreaming when idle and a dream cycle is running', () => {
      useDream.getState().setDreaming(true);
      const { result } = run({ streamStatus: 'idle', agentPhase: null, isUserTyping: false });
      expect(result.current).toBe('dreaming');
    });

    it('typing wins over dreaming', () => {
      useDream.getState().setDreaming(true);
      const { result } = run({ streamStatus: 'idle', agentPhase: null, isUserTyping: true });
      expect(result.current).toBe('typing');
    });

    it('streaming wins over dreaming', () => {
      useDream.getState().setDreaming(true);
      const { result } = run({ streamStatus: 'streaming', agentPhase: null, isUserTyping: false });
      expect(result.current).toBe('thinking');
    });
  });

  describe('new agent phases', () => {
    it('reading while streaming with reading phase', () => {
      const { result } = run({ streamStatus: 'streaming', agentPhase: 'reading', isUserTyping: false });
      expect(result.current).toBe('reading');
    });

    it('searching while streaming with searching phase', () => {
      const { result } = run({ streamStatus: 'streaming', agentPhase: 'searching', isUserTyping: false });
      expect(result.current).toBe('searching');
    });

    it('building while streaming with building phase', () => {
      const { result } = run({ streamStatus: 'streaming', agentPhase: 'building', isUserTyping: false });
      expect(result.current).toBe('building');
    });

    it('writing while streaming with writing phase', () => {
      const { result } = run({ streamStatus: 'streaming', agentPhase: 'writing', isUserTyping: false });
      expect(result.current).toBe('writing');
    });
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

  describe('excited on idle→streaming transition', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('returns excited after idle→streaming transition', () => {
      const { result, rerender } = run({ streamStatus: 'idle', agentPhase: null, isUserTyping: false });
      expect(result.current).toBe('idle');

      act(() => {
        rerender({ streamStatus: 'streaming', agentPhase: null, isUserTyping: false });
      });
      expect(result.current).toBe('excited');
    });

    it('does not trigger excited on first streaming (no prior idle)', () => {
      const { result } = run({ streamStatus: 'streaming', agentPhase: null, isUserTyping: false });
      expect(result.current).toBe('thinking');
    });
  });

  describe('constants', () => {
    it('DONE_HOLD_MS is 1200', () => {
      expect(DONE_HOLD_MS).toBe(1200);
    });

    it('COOL_HOLD_MS is 2400', () => {
      expect(COOL_HOLD_MS).toBe(2400);
    });

    it('EXCITED_HOLD_MS is 800', () => {
      expect(EXCITED_HOLD_MS).toBe(800);
    });
  });
});
