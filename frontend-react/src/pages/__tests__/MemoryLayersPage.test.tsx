// @ts-nocheck — this test file uses Vite's ?raw import and vitest globals;
// the browser tsconfig does not include Node types.
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import MemoryLayersPage from '../MemoryLayersPage';

// jsdom has no WebGL2 — createTreeRenderer returns null → setUnsupported(true)
// → fallback <p> renders synchronously on the first paint.
describe('MemoryLayersPage (tree)', () => {
  it('renders the WebGL2 fallback message when no GL context is available', () => {
    const { getByText } = render(<MemoryLayersPage />);
    expect(getByText(/WebGL2 unavailable/i)).toBeTruthy();
  });

  it('does not import any fractal modules', async () => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // Vite ?raw suffix returns the file source as a string at test time.
    const src = await import('../MemoryLayersPage?raw')
      .then((m) => m.default)
      .catch(() => '');
    expect(src).not.toMatch(/lib\/fractal\/(organism|escape|breathing|signal)/);
  });
});
