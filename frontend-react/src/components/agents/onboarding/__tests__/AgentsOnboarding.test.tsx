import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentsOnboarding } from '../AgentsOnboarding';
import { tauri, type AgentConfig } from '@/lib/tauri';
import { useAgent } from '@/stores/agent';

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return {
    ...actual,
    tauri: {
      ...actual.tauri,
      agents: {
        ...actual.tauri.agents,
        getPresets: vi.fn(),
        getAll:     vi.fn(),
        save:       vi.fn(),
      },
      models: {
        ...actual.tauri.models,
        loaded: vi.fn(),
      },
    },
  };
});

const mockGetPresets = vi.mocked(tauri.agents.getPresets);
const mockGetAll     = vi.mocked(tauri.agents.getAll);
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
  // Reset the agent store between tests so each starts with no active agent.
  useAgent.setState({ list: [], current: null, loading: false, saving: false, error: null });

  mockGetPresets.mockResolvedValue([fakePreset]);
  mockGetAll.mockResolvedValue([]);
  mockLoaded.mockResolvedValue(null);
  mockSave.mockImplementation(async (cfg) => ({ ...cfg, id: 'saved-id-1' }));
});

describe('AgentsOnboarding', () => {
  it('saves agent through the agent store (which sets it as active)', async () => {
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

    // After save, the store must have an active agent. This is the
    // single source of truth that AgentGate reads to flip into chat mode.
    await waitFor(() => {
      const current = useAgent.getState().current;
      expect(current).not.toBeNull();
      expect(current?.name).toBe('Research Assistant');
    });

    // The agent must not carry a runtime-selector field — there's only
    // one runtime in Feral (the Feral Agent sidecar), so persisting
    // any other flag is a regression to flag.
    const saved = useAgent.getState().current as unknown as Record<string, unknown>;
    expect(Object.keys(saved)).not.toContain('preferred_runtime');
  });
});
