import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AppearanceTab } from '../AppearanceTab';
import { tauri } from '@/lib/tauri';

vi.mock('@/lib/tauri', () => ({
  tauri: {
    settings: { get: vi.fn() },
    raw: { setWindowSolid: vi.fn().mockResolvedValue(undefined) },
  },
}));

const get = tauri.settings.get as unknown as ReturnType<typeof vi.fn>;

/** Solid is the default the Rust side uses; the tab must show the same one. */
describe('AppearanceTab: background', () => {
  beforeEach(() => vi.clearAllMocks());

  test('settings without the key show Solid, like the engine uses', async () => {
    get.mockResolvedValue({});
    render(<AppearanceTab />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Solid' })).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByRole('button', { name: 'Glass' })).toHaveAttribute('aria-pressed', 'false');
  });

  test('settings that cannot be read show Solid too', async () => {
    get.mockRejectedValue(new Error('no engine'));
    render(<AppearanceTab />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Solid' })).toHaveAttribute('aria-pressed', 'true'));
  });

  test('a stored Glass choice is kept', async () => {
    get.mockResolvedValue({ window_solid: false });
    render(<AppearanceTab />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Glass' })).toHaveAttribute('aria-pressed', 'true'));
  });
});
