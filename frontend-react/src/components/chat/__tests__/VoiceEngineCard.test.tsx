/**
 * The bug this file exists for: two stores held "which voice answers".
 *
 * This card wrote the voice into the BYOK record; the in-call picker wrote it
 * into `ttsVoice`; and the call passes `ttsVoice` explicitly, which wins inside
 * the engine. So picking Raluca here, pressing Save and watching it persist
 * still got you Mihai — the in-call picker had pinned its own guess the first
 * time it opened, and nothing reconciled the two.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { VoiceEngineCard } from '@/components/chat/VoiceEngineCard';
import { tauri, type TtsProviderInfo } from '@/lib/tauri';
import { events } from '@/lib/tauri/events';
import { useUI } from '@/stores/ui';

const PIPER: TtsProviderInfo = {
  id: 'piper',
  label: 'Piper',
  isLocal: true,
  needsKey: false,
  needsBaseUrl: false,
  needsModel: true,
  needsDownload: true,
  consoleUrl: null,
  note: 'On device. ~60 MB voice, 35+ languages. MIT.',
  available: true,
};

beforeEach(() => {
  useUI.setState({ ttsProvider: null, ttsVoice: {}, language: 'en' });
  vi.spyOn(events.onTtsDownloadProgress, 'listen').mockResolvedValue(() => {});
  vi.spyOn(events.onTtsDownloadComplete, 'listen').mockResolvedValue(() => {});
  vi.spyOn(events.onTtsDownloadError, 'listen').mockResolvedValue(() => {});
  vi.spyOn(tauri.voice, 'ttsProviders').mockResolvedValue([PIPER]);
  vi.spyOn(tauri.voice, 'ttsHasKey').mockResolvedValue(false);
  // Present, so Save is not blocked on a download.
  vi.spyOn(tauri.voice, 'voicePresent').mockResolvedValue(true);
  vi.spyOn(tauri.voice, 'saveTtsKey').mockResolvedValue();
});

afterEach(() => vi.restoreAllMocks());

describe('VoiceEngineCard', () => {
  it('pins the chosen voice where the CALL reads it, not only in the BYOK record', async () => {
    render(<VoiceEngineCard open onOpenChange={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: /ryan/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      expect(useUI.getState().ttsVoice.piper).toBe('en_US-ryan-high');
    });
    // And still written to the engine's own record, which is what a fresh
    // process reads before anything has been pinned.
    expect(tauri.voice.saveTtsKey).toHaveBeenCalledWith(
      'piper', '', undefined, 'en_US-ryan-high',
    );
  });

  it('opens showing the voice that is actually pinned, not the fallback', async () => {
    useUI.setState({ ttsVoice: { piper: 'en_GB-alba-medium' } });
    render(<VoiceEngineCard open onOpenChange={() => {}} />);

    // The chip for the pinned voice is the selected one. Selection is carried
    // by colour, so assert on the value the field holds instead.
    await waitFor(() => {
      expect(screen.getByDisplayValue('en_GB-alba-medium')).toBeInTheDocument();
    });
  });

  it('offers voices for the interface language, and no language is hardcoded', async () => {
    render(<VoiceEngineCard open onOpenChange={() => {}} />);
    // English UI → English shortlist. The Romanian-only list that used to ship
    // to everyone is the thing this pins against.
    expect(await screen.findByRole('button', { name: /amy/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /mihai/ })).toBeNull();

    useUI.setState({ language: 'ro' });
    await waitFor(() => expect(screen.getByRole('button', { name: /raluca/ })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /amy/ })).toBeNull();
  });
});
