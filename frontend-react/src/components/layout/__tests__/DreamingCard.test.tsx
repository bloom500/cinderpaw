import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DreamingCard, dreamProgress } from '../DreamingCard';
import { useDream } from '@/stores/dream';
import { useUI } from '@/stores/ui';

beforeEach(() => {
  useDream.setState({ dreaming: false, stage: null });
  useUI.setState({ mascotEnabled: false });
});

describe('DreamingCard', () => {
  it('is not there unless a dream cycle runs', () => {
    const { container } = render(<DreamingCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says what the stage is doing, and the bar follows the stages', () => {
    useDream.setState({ dreaming: true, stage: 'evaluate' });
    render(<DreamingCard />);
    expect(screen.getByRole('status', { name: 'Dreaming' })).toBeTruthy();
    expect(screen.getByText('Testing what it tried')).toBeTruthy();
    expect(dreamProgress(null)).toBe(0);
    expect(dreamProgress('wake')).toBeCloseTo(0.2);
    expect(dreamProgress('sleep')).toBe(1);
  });
});
