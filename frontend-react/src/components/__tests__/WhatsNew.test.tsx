import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/onboarding', () => ({
  useOnboarding: { getState: () => ({ loadPersisted: async () => true }) },
}));

import { WhatsNew, useWhatsNew } from '../WhatsNew';

describe("What's new", () => {
  it('a click outside the card (or on the Alpha card) does not close it; Got it does', async () => {
    localStorage.clear();
    render(<WhatsNew />);
    useWhatsNew.getState().show();
    expect(await screen.findByText('Feral has a new name')).toBeTruthy();
    // Radix starts listening for outside clicks one tick after it opens.
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.pointerDown(document.body);
    fireEvent.mouseDown(document.body);
    fireEvent.click(document.body);
    expect(useWhatsNew.getState().open).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(useWhatsNew.getState().open).toBe(false);
  });
});
