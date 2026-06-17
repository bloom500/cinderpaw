import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { WaveformBars } from '../WaveformBars';

describe('WaveformBars', () => {
  it('renders one bar per peak', () => {
    const { container } = render(<WaveformBars peaks={[0.1, 0.5, 1]} progress={0} />);
    expect(container.querySelectorAll('[data-bar]')).toHaveLength(3);
  });

  it('marks bars before progress as played', () => {
    const { container } = render(<WaveformBars peaks={[0.2, 0.2, 0.2, 0.2]} progress={0.5} />);
    const played = container.querySelectorAll('[data-played="true"]');
    expect(played).toHaveLength(2);
  });
});
