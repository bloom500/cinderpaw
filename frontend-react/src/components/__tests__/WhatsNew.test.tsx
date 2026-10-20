import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/onboarding', () => ({
  useOnboarding: Object.assign((sel: (s: { active: boolean }) => unknown) => sel({ active: false }), {
    getState: () => ({ loadPersisted: async () => true }),
  }),
}));

import { WhatsNew, useWhatsNew } from '../WhatsNew';
import { AlphaNotice } from '../AlphaNotice';
import { useAttention } from '@/lib/attention';

// Radix starts listening for outside clicks one tick after the card opens.
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("What's new closes only on purpose", () => {
  beforeEach(() => {
    localStorage.clear();
    useWhatsNew.setState({ open: false, due: false });
    useAttention.setState({ waiting: [], holder: null });
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

  it("for someone who updated: What's new first, the Alpha card only after it is closed", async () => {
    useWhatsNew.setState({ due: null });
    render(<MemoryRouter><WhatsNew /><AlphaNotice /></MemoryRouter>);
    expect(await screen.findByText('Feral has a new name')).toBeTruthy();
    expect(screen.queryByText('Cinderpaw is in alpha')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(await screen.findByText('Cinderpaw is in alpha')).toBeTruthy();
  });
});
