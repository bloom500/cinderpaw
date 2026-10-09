import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SoundSettings } from '../SoundSettings';
import { useSoundSettings } from '@/stores/sounds';
import { playUiSound } from '@/lib/uiSounds';

vi.mock('@/lib/uiSounds', async (original) => ({
  ...await original<typeof import('@/lib/uiSounds')>(),
  playUiSound: vi.fn(async () => true),
}));
vi.mock('@/components/voice/ListenButton', () => ({ ListenButton: ({ line }: { line: string }) => <button>{line}</button> }));

describe('Sound settings', () => {
  beforeEach(() => {
    useSoundSettings.setState({ enabled: true, volume: 0.35 });
    vi.clearAllMocks();
  });
  it('persists mute and volume without touching the system or voice volume', () => {
    render(<SoundSettings />);
    fireEvent.click(screen.getByRole('switch', { name: 'Sound effects' }));
    fireEvent.change(screen.getByRole('slider', { name: 'Sound effects volume' }), { target: { value: '24' } });
    expect(useSoundSettings.getState()).toMatchObject({ enabled: false, volume: 0.24 });
    expect(JSON.parse(localStorage.getItem('cinderpaw-sounds')!).state).toEqual({ enabled: false, volume: 0.24 });
  });
  it('allows an explicit audition with effects muted', async () => {
    useSoundSettings.setState({ enabled: false });
    render(<SoundSettings />);
    fireEvent.click(screen.getByText('Listen to the sound pack'));
    fireEvent.click(screen.getByRole('button', { name: 'Preview Task completed' }));
    await waitFor(() => expect(playUiSound).toHaveBeenCalledWith('task-done', true));
  });
  it('lets the person choose each of the six recorded Cubby lines', () => {
    render(<SoundSettings />);
    expect(screen.getAllByRole('option')).toHaveLength(6);
    fireEvent.change(screen.getByRole('combobox', { name: 'Voice sample' }), { target: { value: 'onboarding.done' } });
    expect(screen.getByRole('button', { name: 'onboarding.done' })).toBeInTheDocument();
  });
});
