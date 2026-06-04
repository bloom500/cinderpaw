import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentsOnboarding } from '../AgentsOnboarding';
import { tauri, type AgentConfig } from '@/lib/tauri';

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return {
    ...actual,
    tauri: {
      ...actual.tauri,
      agents: {
        ...actual.tauri.agents,
        getPresets: vi.fn(),
        save: vi.fn(),
      },
      models: {
        ...actual.tauri.models,
        loaded: vi.fn(),
      },
    },
  };
});

const mockGetPresets = vi.mocked(tauri.agents.getPresets);
const mockSave       = vi.mocked(tauri.agents.save);
const mockLoaded     = vi.mocked(tauri.models.loaded);

const fakePreset: AgentConfig = {
  id: 'preset-1',
  name: 'Research Assistant',
  system_prompt: 'You research things.',
  model_id: '',
  tools: ['web_search'],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPresets.mockResolvedValue([fakePreset]);
  mockLoaded.mockResolvedValue(null);
  mockSave.mockImplementation(async (cfg) => ({ ...cfg, id: 'saved-id-1' }));
});

describe('AgentsOnboarding', () => {
  it('saves agent without preferred_runtime field (Feral Agent only)', async () => {
    const user = userEvent.setup();
    render(<AgentsOnboarding onDone={vi.fn()} onSkip={vi.fn()} />);

    // Welcome → pick preset
    await user.click(await screen.findByRole('button', { name: /continue/i }));

    // Pick preset card
    const card = await screen.findByText('Research Assistant');
    await user.click(card);
    await user.click(screen.getByRole('button', { name: /continue/i }));

    // Name step — name is pre-filled from preset; just continue
    await user.click(screen.getByRole('button', { name: /continue/i }));

    // Review step → save
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(mockSave).toHaveBeenCalled());

    const savedCfg = mockSave.mock.calls[0][0];
    // The Feral Agent stack is the only runtime — no runtime selector field
    // is sent to the backend. This guards against re-introducing a runtime
    // flag (e.g. a second sidecar) without an explicit decision.
    expect(Object.keys(savedCfg)).not.toContain('preferred_runtime');
  });
});
