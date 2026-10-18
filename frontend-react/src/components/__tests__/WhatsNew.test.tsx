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

// Radix starts listening for outside clicks one tick after the card opens.
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("What's new closes only on purpose", () => {
  beforeEach(() => {
    localStorage.clear();
    useWhatsNew.setState({ open: false });
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

  it('closing the Alpha card in the corner closes only the Alpha card', async () => {
    render(<MemoryRouter><WhatsNew /><AlphaNotice /></MemoryRouter>);
    useWhatsNew.getState().show();
    expect(await screen.findByText('Feral has a new name')).toBeTruthy();
    await tick();
    // The open card hides the rest of the page from screen readers, hence hidden: true.
    const x = screen.getByRole('button', { name: 'Dismiss notice', hidden: true });
    fireEvent.pointerDown(x);
    fireEvent.click(x);
    expect(screen.queryByText('Cinderpaw is in alpha')).toBeNull();
    expect(useWhatsNew.getState().open).toBe(true);
  });
});
