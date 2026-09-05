import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';

/**
 * A frameless window whose minimise, maximise and close buttons can be covered
 * is a window nobody can put away.
 *
 * They were covered, and raising their z-index could never have uncovered them:
 * the band lives inside `#root`, which sets `z-index: 1`, and inside
 * `.app-pane`, which has a `backdrop-filter`. Both open a stacking context, so
 * `z-[200]` there is 200 within a layer worth 1, while the call overlay is
 * portalled to <body> at z-40 and compared against that 1. Leaving the context
 * is the only fix, and "is it a child of <body>" is the only part of that a
 * test in jsdom can see — jsdom computes no stacking at all, so the number
 * cannot be asserted and the structure has to be.
 */

// Nothing here talks to a real window or a real event bus. Both are mocked at
// the module boundary rather than per component, because several modules
// subscribe on import and an unmocked `listen` rejects during the import itself,
// where no test can catch it.
vi.mock('@tauri-apps/api/event', () => ({
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
  }),
}));

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

/** The element the router renders the app into, as `main.tsx` does. */
function renderInRoot() {
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
  render(
    <MemoryRouter>
      <AppShell />
    </MemoryRouter>,
    { container: root },
  );
  return root;
}

describe('window chrome', () => {
  it('is not rendered inside the page, so nothing on the page can cover it', () => {
    const root = renderInRoot();
    for (const label of ['Minimize', 'Maximize', 'Close']) {
      const button = screen.getByLabelText(label);
      expect(root.contains(button)).toBe(false);
      expect(document.body.contains(button)).toBe(true);
    }
  });

  it('keeps the toast column out of the page too', () => {
    // Same defect, same band: an error explaining a failed call was painted
    // over by the call it was explaining.
    const root = renderInRoot();
    const column = document.querySelector('.fixed.top-11.right-4');
    expect(column).not.toBeNull();
    expect(root.contains(column)).toBe(false);
  });
});
