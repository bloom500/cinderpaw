import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { ThinkingBlock, thinkingLabel } from '../ThinkingBlock';
import { useChat } from '@/stores/chat';

beforeEach(() => useChat.setState({ expandedThinkingIds: {} } as never));

describe('thinkingLabel', () => {
  it('never shows a number nobody measured', () => {
    // A reopened conversation has no duration: it used to say "Thought for 0s".
    expect(thinkingLabel(undefined)).toBe('Reasoning');
    expect(thinkingLabel(400)).toBe('Thought for a moment');
    expect(thinkingLabel(1000)).toBe('Thought for 1 second');
    expect(thinkingLabel(12_300)).toBe('Thought for 12 seconds');
    expect(thinkingLabel(72_000)).toBe('Thought for 1 min 12 s');
  });
});

describe('ThinkingBlock', () => {
  it('is open while the model thinks, and folded once the answer starts', () => {
    const { rerender } = render(<ThinkingBlock id="m" content="weighing options" active />);
    expect(screen.getByText('weighing options')).toBeVisible();

    rerender(<ThinkingBlock id="m" content="weighing options" durationMs={3000} active={false} />);
    expect(screen.queryByText('weighing options')).not.toBeInTheDocument();
    expect(screen.getByText('Thought for 3 seconds')).toBeInTheDocument();
  });

  it('opens on click after the answer, and remembers it', async () => {
    render(<ThinkingBlock id="m" content="weighing options" durationMs={3000} active={false} />);
    await userEvent.click(screen.getByRole('button', { name: /Thought for 3 seconds/ }));
    expect(screen.getByText('weighing options')).toBeVisible();
    expect(useChat.getState().expandedThinkingIds.m).toBe(true);
  });
});
