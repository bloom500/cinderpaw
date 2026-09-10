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
  // The perch reads the creature's real on-screen width from here rather than
  // keeping its own copy of it, so the mock has to carry it too.
  DISPLAY: 48,
  usePrefersReducedMotion: () => false,
}));

vi.mock('../ToolCallStack', () => ({ ToolCallStack: () => null }));

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
    // The bond is stored, so without this each test inherits the pokes and
    // sessions of the ones before it and the tier drifts up mid-file.
    try { window.localStorage.clear(); } catch { /* blocked storage: fine */ }
  });
  afterEach(() => vi.useRealTimers());

  it('ignores the pointer passing over it', () => {
    // The creature lives beside the text field, so the cursor crosses it by
    // accident dozens of times an hour. A pose that fires that often is noise,
    // which is exactly what was reported.
    render(<MascotPerch baseState="idle" />);
    expect(shown()).toBe('idle');
    fireEvent.pointerEnter(creature());
    expect(shown()).toBe('idle');
    fireEvent.pointerLeave(creature());
    expect(shown()).toBe('idle');
  });

  it('does not strike a pose when it is clicked', () => {
    render(<MascotPerch baseState="idle" />);
    pokeIt();
    expect(shown()).toBe('idle');
    pokeIt();
    pokeIt();
    expect(shown()).toBe('idle');
  });

  it('still shows what the agent is doing', () => {
    // The states did not go anywhere. What changed is what wakes them.
    const { rerender } = render(<MascotPerch baseState="idle" />);
    rerender(<MascotPerch baseState="reading" />);
    expect(shown()).toBe('reading');
    rerender(<MascotPerch baseState="done" />);
    expect(shown()).toBe('done');
  });

  it('never paints a reaction over what the agent is doing', () => {
    render(<MascotPerch baseState="thinking" />);
    fireEvent.pointerEnter(creature());
    pokeIt();
    // `thinking` is information about the turn in flight. A poke is not
    // allowed to hide it.
    expect(shown()).toBe('thinking');
  });

  it('dozes off only after a long quiet, and work wakes it', () => {
    const { rerender } = render(<MascotPerch baseState="idle" />);
    act(() => { vi.advanceTimersByTime(44_000); });
    expect(shown()).toBe('idle');
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(shown()).toBe('sleep');
    // Not a click any more: the thing that wakes it is the agent starting to
    // work, which is the only reason anybody needs it awake.
    rerender(<MascotPerch baseState="thinking" />);
    expect(shown()).toBe('thinking');
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

  it('ignores a wobble of a pixel or two, so a shaky click is not a drag', () => {
    render(<MascotPerch baseState="idle" />);
    const perch = creature().parentElement!;
    fireEvent.pointerDown(creature(), { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(creature(), { pointerId: 1, clientX: 2, clientY: 1 });
    fireEvent.pointerUp(creature(), { pointerId: 1, clientX: 2, clientY: 1 });
    expect(perch.style.transform).toBe('translate(0px, 0px)');
  });

  it('renders nothing at all when the kill switch is off', () => {
    useUI.setState({ mascotEnabled: false });
    render(<MascotPerch baseState="idle" />);
    expect(screen.queryByTestId('mascot')).toBeNull();
  });
});
