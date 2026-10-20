import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const persisted = vi.hoisted(() => ({ load: async () => true as boolean }));
vi.mock('@/stores/onboarding', () => ({
  useOnboarding: Object.assign((sel: (s: { active: boolean }) => unknown) => sel({ active: false }), {
    getState: () => ({ loadPersisted: () => persisted.load() }),
  }),
}));

import { act } from '@testing-library/react';
import { WhatsNew, useWhatsNew, WHATS_NEW_DECIDE_MS } from '../WhatsNew';
import { useAttention } from '@/lib/attention';

// Radix starts listening for outside clicks one tick after the card opens.
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("What's new closes only on purpose", () => {
  beforeEach(() => {
    localStorage.clear();
    useWhatsNew.setState({ open: false, due: false });
    useAttention.setState({ waiting: [], holder: null });
    persisted.load = async () => true;
  });

  it('a read that never answers stops holding the queue, without marking the release seen', async () => {
    vi.useFakeTimers();
    try {
      persisted.load = () => new Promise<boolean>(() => {});
      useWhatsNew.setState({ due: null });
      render(<WhatsNew />);
      expect(useWhatsNew.getState().due).toBeNull();
      act(() => { vi.advanceTimersByTime(WHATS_NEW_DECIDE_MS); });
      expect(useWhatsNew.getState().due).toBe(false);
      expect(localStorage.getItem('cinderpaw.whatsNew.seen')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a click outside the card does not close it; Got it does', async () => {
    render(<WhatsNew />);
    useWhatsNew.getState().show();
    expect(await screen.findByText('Feral has a new name')).toBeTruthy();
    await tick();
    fireEvent.pointerDown(document.body);
    fireEvent.mouseDown(document.body);
    fireEvent.click(document.body);
    expect(useWhatsNew.getState().open).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(useWhatsNew.getState().open).toBe(false);
  });

  it("for someone who updated: What's new holds the notice turn until it is closed", async () => {
    useWhatsNew.setState({ due: null });
    render(<MemoryRouter><WhatsNew /></MemoryRouter>);
    expect(await screen.findByText('Feral has a new name')).toBeTruthy();
    expect(useAttention.getState().holder).toBe('whatsNew');
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(useAttention.getState().holder).toBeNull();
  });
});
