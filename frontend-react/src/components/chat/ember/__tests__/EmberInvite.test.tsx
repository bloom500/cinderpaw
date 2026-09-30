import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EmberInvite } from '../EmberInvite';
import type { EmberRun } from '../useEmberRun';

const runOf = (over: Partial<EmberRun> = {}): EmberRun => ({
  offered: false, open: false, round: null, openPanel: vi.fn(), closePanel: vi.fn(), ...over,
});

describe('EmberInvite', () => {
  it('is absent until the game is offered', () => {
    const { container } = render(<EmberInvite run={runOf()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('opens the panel when clicked', () => {
    const run = runOf({ offered: true });
    render(<EmberInvite run={run} />);
    fireEvent.click(screen.getByRole('button', { name: /campfire game/i }));
    expect(run.openPanel).toHaveBeenCalledTimes(1);
  });
});
