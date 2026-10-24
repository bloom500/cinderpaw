import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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

  it('shows the complete card immediately without a morph for reduced motion', () => {
    preference.reduced = true;
    const { container } = render(<GooeyCard><p>Evidence and actions</p></GooeyCard>);
    expect(screen.getByText('Evidence and actions')).toBeVisible();
    expect(container.querySelector('svg')).toBeNull();
    expect(container.firstElementChild).toHaveAttribute('data-reduced-motion', 'true');
  });
});
