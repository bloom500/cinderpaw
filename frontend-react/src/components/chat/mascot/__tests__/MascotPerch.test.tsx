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


const shown = () => screen.getByTestId('mascot').getAttribute('data-state');
/** A poke is now a press and a release that never moved: the same gesture that
 *  used to be a bare `pointerdown`, since holding it is how you pick it up. */
const pokeIt = () => {
  fireEvent.pointerDown(creature(), { pointerId: 1, clientX: 0, clientY: 0 });
  fireEvent.pointerUp(creature(), { pointerId: 1, clientX: 0, clientY: 0 });
};
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
    pokeIt();
    expect(shown()).toBe('surprised');
    pokeIt();
    pokeIt();
    expect(shown()).toBe('love');
  });

  it('forgets the bout when the pokes are far apart', () => {
    render(<MascotPerch baseState="idle" />);
    for (let i = 0; i < 3; i++) {
      pokeIt();
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
    pokeIt();
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
    pokeIt();
    expect(shown()).toBe('surprised');
  });

  it('can be picked up and carried, and that is not a poke', () => {
    render(<MascotPerch baseState="idle" />);
    const perch = creature().parentElement!;
    fireEvent.pointerDown(creature(), { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(creature(), { pointerId: 1, clientX: 30, clientY: -40 });
    // Held by the scruff, which outranks every other state including a turn in
    // flight, and the perch has actually moved with the pointer.
    expect(shown()).toBe('surprised');
    expect(perch.style.transform).toBe('translate(30px, -40px)');
  });

  it('ignores a wobble of a pixel or two, so a shaky poke stays a poke', () => {
    render(<MascotPerch baseState="idle" />);
    const perch = creature().parentElement!;
    fireEvent.pointerDown(creature(), { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(creature(), { pointerId: 1, clientX: 2, clientY: 1 });
    fireEvent.pointerUp(creature(), { pointerId: 1, clientX: 2, clientY: 1 });
    expect(perch.style.transform).toBe('translate(0px, 0px)');
    expect(shown()).toBe('surprised');
  });

  it('renders nothing at all when the kill switch is off', () => {
    useUI.setState({ mascotEnabled: false });
    render(<MascotPerch baseState="idle" />);
    expect(screen.queryByTestId('mascot')).toBeNull();
  });
});
