import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { GooeyCard } from '../GooeyCard';

const preference = vi.hoisted(() => ({ reduced: false }));
vi.mock('framer-motion', async (original) => ({
  ...await original<typeof import('framer-motion')>(),
  useReducedMotion: () => preference.reduced,
}));

describe('gooey card entrance', () => {
  it('keeps real buttons usable, outside the decorative liquid surface', () => {
    preference.reduced = false;
    const click = vi.fn();
    const { container } = render(<GooeyCard><button onClick={click}>Create task</button></GooeyCard>);
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    expect(click).toHaveBeenCalledOnce();
    expect(container.querySelector('button button')).toBeNull();
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('feColorMatrix')).toHaveAttribute('values', expect.stringContaining('20 -10'));
  });

  // 26 Oct: settled on the spring's end, a card that kept growing (a tool row
  // every few hundred ms) restarted the spring before it ended and kept the
  // filter, 11 long frames in 2.5 s. It settles on time now, growing or not.
  it('with settle, drops the liquid after the entrance even while the card keeps growing', () => {
    vi.useFakeTimers();
    preference.reduced = false;
    const { container, rerender } = render(<GooeyCard bare settle><p>Row 1</p></GooeyCard>);
    expect(container.querySelector('[data-gooey-card] > svg')).not.toBeNull();
    act(() => { vi.advanceTimersByTime(400); });
    rerender(<GooeyCard bare settle><p>Row 1</p><p>Row 2</p></GooeyCard>);
    act(() => { vi.advanceTimersByTime(700); });
    expect(container.querySelector('[data-gooey-card] > svg')).toBeNull();
    vi.useRealTimers();
  });

  it('shows the complete card immediately without a morph for reduced motion', () => {
    preference.reduced = true;
    const { container } = render(<GooeyCard><p>Evidence and actions</p></GooeyCard>);
    expect(screen.getByText('Evidence and actions')).toBeVisible();
    expect(container.querySelector('svg')).toBeNull();
    expect(container.firstElementChild).toHaveAttribute('data-reduced-motion', 'true');
  });
});
