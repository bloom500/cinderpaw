import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppearanceTab } from '../AppearanceTab';
import { tauri } from '@/lib/tauri';
import { useUI } from '@/stores/ui';

vi.mock('@/lib/tauri', () => ({
  tauri: {
    settings: { get: vi.fn() },
    raw: { setWindowSolid: vi.fn().mockResolvedValue(undefined) },
  },
}));

vi.mock('@/components/chat/ember/emberAvailability', () => ({
  emberAvailability: vi.fn(() => Promise.resolve({ ok: true })),
}));
import { emberAvailability } from '@/components/chat/ember/emberAvailability';

const get = tauri.settings.get as unknown as ReturnType<typeof vi.fn>;

/** Solid is the default the Rust side uses; the tab must show the same one. */
describe('AppearanceTab: background', () => {
  beforeEach(() => vi.clearAllMocks());

  test('settings without the key show Solid, like the engine uses', async () => {
    get.mockResolvedValue({});
    render(<AppearanceTab />);
    await waitFor(() => expect(screen.getByRole('radio', { name: /Solid/ })).toBeChecked());
    expect(screen.getByRole('radio', { name: /Glass/ })).not.toBeChecked();
  });

  test('settings that cannot be read show Solid too', async () => {
    get.mockRejectedValue(new Error('no engine'));
    render(<AppearanceTab />);
    await waitFor(() => expect(screen.getByRole('radio', { name: /Solid/ })).toBeChecked());
  });

  test('a stored Glass choice is kept', async () => {
    get.mockResolvedValue({ window_solid: false });
    render(<AppearanceTab />);
    await waitFor(() => expect(screen.getByRole('radio', { name: /Glass/ })).toBeChecked());
  });

  test('picking Glass tells the window', async () => {
    get.mockResolvedValue({});
    render(<AppearanceTab />);
    await waitFor(() => expect(screen.getByRole('radio', { name: /Solid/ })).toBeChecked());
    await userEvent.click(screen.getByRole('radio', { name: /Glass/ }));
    expect(tauri.raw.setWindowSolid).toHaveBeenCalledWith(false);
  });
});

describe('AppearanceTab: theme and chat font', () => {
  beforeEach(() => {
    get.mockResolvedValue({});
    useUI.setState({ theme: 'system', chatFont: 'geist' });
  });

  test('a fresh install has System and Geist selected', () => {
    render(<AppearanceTab />);
    expect(screen.getByRole('button', { name: /^System/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('radio', { name: /Geist/ })).toBeChecked();
  });

  test('a theme card sets the theme, a font row sets the chat font', async () => {
    render(<AppearanceTab />);
    await userEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(useUI.getState().theme).toBe('dark');
    await userEvent.click(screen.getByRole('radio', { name: /System font/ }));
    expect(useUI.getState().chatFont).toBe('system');
  });
});

describe('AppearanceTab: campfire game', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    get.mockResolvedValue({});
  });

  test('turns the switch off and says why on a machine that cannot run the game', async () => {
    vi.mocked(emberAvailability).mockResolvedValueOnce({ ok: false, reason: "This computer's graphics don't support WebGL 2, which the game needs." });
    render(<AppearanceTab />);
    const sw = await screen.findByRole('switch', { name: /campfire game/i });
    await waitFor(() => expect(sw).toBeDisabled());
    expect(screen.getByText(/WebGL 2/)).toBeInTheDocument();
  });

  test('the switch turns the game on and off', async () => {
    render(<AppearanceTab />);
    const sw = await screen.findByRole('switch', { name: /campfire game/i });
    const before = useUI.getState().emberGameEnabled;
    await userEvent.click(sw);
    expect(useUI.getState().emberGameEnabled).toBe(!before);
  });
});
