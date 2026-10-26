import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { tauri, type Settings } from '@/lib/tauri';
import { useOnboarding } from '@/stores/onboarding';
import { useSettings } from '@/stores/settings';
import { ShareUsageCard } from '../ShareUsageCard';
import { useConversations } from '@/stores/conversations';

// Final review M4: real stores, so the card sees what the wizard saved.
describe('ShareUsageCard after the welcome wizard', () => {
  it('does not ask again once the last setup screen answered', async () => {
    let saved: boolean | null = null;
    vi.spyOn(tauri.system, 'setUsageSharing').mockImplementation(async (on: boolean) => { saved = on; });
    vi.spyOn(tauri.system, 'countInstall').mockResolvedValue(undefined);
    vi.spyOn(tauri.settings, 'get').mockImplementation(async () => ({ usage_sharing: saved }) as Settings);
    // First run: the home screen mounts under the wizard and loads "never asked".
    // An install that already had a conversation, so the card would ask.
    useSettings.setState({ settings: { usage_sharing: null } as Settings });
    useConversations.setState({ list: [{ id: 'c1' }] as never });
    render(<ShareUsageCard />);
    expect(await screen.findByText(/Help other people pick a model\?/)).toBeInTheDocument();

    useOnboarding.getState().setShareUsage(true);
    await act(() => useOnboarding.getState().finish());

    await waitFor(() => expect(screen.queryByText(/Help other people pick a model\?/)).toBeNull());
    expect(saved).toBe(true);
  });
});
