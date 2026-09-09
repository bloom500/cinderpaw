import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { MascotPerch } from '../MascotPerch';
import { useUI } from '@/stores/ui';

// The sprite is a canvas, which jsdom cannot draw. What this file is about is
// WHICH state the perch decides to show, so the creature is replaced by a
// element that simply prints the state it was handed.
vi.mock('../CinderpawMascot', () => ({
  CinderpawMascot: ({ state }: { state: string }) => (
    <span data-testid="mascot" data-state={state} />
  ),
  usePrefersReducedMotion: () => false,
}));

vi.mock('../ToolCallStack', () => ({ ToolCallStack: () => null }));

const shown = () => screen.getByTestId('mascot').getAttribute('data-state');
/** The pointer target is the creature's own wrapper, not the perch. */
const creature = () => screen.getByTestId('mascot').parentElement!;

describe('MascotPerch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useUI.setState({ mascotEnabled: true });
  });
  afterEach(() => vi.useRealTimers());

  it('notices the pointer, and stops when it leaves', () => {
    render(<MascotPerch baseState="idle" />);
    expect(shown()).toBe('idle');
    fireEvent.pointerEnter(creature());
    expect(shown()).toBe('curious');
    fireEvent.pointerLeave(creature());
    expect(shown()).toBe('idle');
  });

  it('is startled by one poke and smitten by three in a row', () => {
    render(<MascotPerch baseState="idle" />);
    fireEvent.pointerDown(creature());
    expect(shown()).toBe('surprised');
    fireEvent.pointerDown(creature());
    fireEvent.pointerDown(creature());
    expect(shown()).toBe('love');
  });

  it('forgets the bout when the pokes are far apart', () => {
    render(<MascotPerch baseState="idle" />);
    for (let i = 0; i < 3; i++) {
      fireEvent.pointerDown(creature());
      // Asserted while the reaction is still on screen. Checking after it
      // expired would pass whether the bout reset or not, since both `love`
      // and `surprised` are gone by then.
      expect(shown()).toBe('surprised');
      // Past POKE_BOUT_MS, so each poke is a fresh bout rather than the third
      // of one. Someone who prods it once an hour is never "smitten".
      act(() => { vi.advanceTimersByTime(3_000); });
    }
    expect(shown()).toBe('idle');
  });

  it('never paints a reaction over what the agent is doing', () => {
    render(<MascotPerch baseState="thinking" />);
    fireEvent.pointerEnter(creature());
    fireEvent.pointerDown(creature());
    // `thinking` is information about the turn in flight. A poke is not
    // allowed to hide it.
    expect(shown()).toBe('thinking');
  });

  it('dozes off only after a long quiet, and a poke wakes it', () => {
    render(<MascotPerch baseState="idle" />);
    act(() => { vi.advanceTimersByTime(44_000); });
    expect(shown()).toBe('idle');
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(shown()).toBe('sleep');
    fireEvent.pointerDown(creature());
    expect(shown()).toBe('surprised');
  });

  it('renders nothing at all when the kill switch is off', () => {
    useUI.setState({ mascotEnabled: false });
    render(<MascotPerch baseState="idle" />);
    expect(screen.queryByTestId('mascot')).toBeNull();
  });
});
