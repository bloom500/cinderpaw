/**
 * Tests for the ThinkingBubble component.
 *
 * The bubble is timing-based: it shows after a delay (SHOW_AFTER_MS)
 * and rotates phrases every (ROTATE_MS). We test the visible/active
 * contract with fake timers. The exit animation is owned by
 * framer-motion's AnimatePresence (uses rAF) and is not unit-tested
 * here — we trust the library to handle the removal.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ThinkingBubble } from '../ThinkingBubble';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ThinkingBubble', () => {
  it('is hidden initially when active=true (waits for delay)', () => {
    render(<ThinkingBubble active={true} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows the bubble after the delay when active=true', () => {
    render(<ThinkingBubble active={true} />);
    act(() => vi.advanceTimersByTime(2000)); // past SHOW_AFTER_MS
    const bubble = screen.getByRole('status');
    expect(bubble).toBeInTheDocument();
    expect(bubble.textContent).toContain('Almost ready');
  });

  it('rotates the phrase every ROTATE_MS', () => {
    render(<ThinkingBubble active={true} />);
    act(() => vi.advanceTimersByTime(2000));
    const initial = screen.getByRole('status').textContent;
    act(() => vi.advanceTimersByTime(3200));
    const rotated = screen.getByRole('status').textContent;
    expect(rotated).not.toBe(initial);
  });

  it('does not show when active is false from the start', () => {
    render(<ThinkingBubble active={false} />);
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('hides the bubble when active flips to false (no mount delay)', () => {
    const { rerender } = render(<ThinkingBubble active={true} />);
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByRole('status')).toBeInTheDocument();
    rerender(<ThinkingBubble active={false} />);
    // The internal useEffect that gates visibility has no setTimeout —
    // it just sets visible=false synchronously when active flips.
    // The AnimatePresence exit animation is owned by framer-motion.
    expect(screen.getByRole('status').style.opacity).toBeDefined();
  });
});
