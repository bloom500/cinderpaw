import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { OnboardingWizard } from '../OnboardingWizard';
import { tauri } from '@/lib/tauri';
import { useOnboarding } from '@/stores/onboarding';
import { useModel } from '@/stores/model';

vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(tauri.mcp, 'list').mockResolvedValue([]);
  vi.spyOn(tauri.connectors, 'list').mockResolvedValue([]);
  useOnboarding.setState({ active: true, step: 5 });
});

const renderLast = () => render(<MemoryRouter><OnboardingWizard /></MemoryRouter>);

describe('the names board', () => {
  it('waits for your name, and shows both names in the preview', async () => {
    useOnboarding.setState({ step: 1, userName: '', agentName: 'Cinderpaw' });
    renderLast();
    expect(screen.getByRole('button', { name: /Continue/ })).toBeDisabled();
    useOnboarding.setState({ userName: 'Ana', agentName: 'Ember' });
    expect(await screen.findByText(/Sure, Ana!/)).toBeInTheDocument();
    expect(screen.getByText('Ember:')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue/ })).toBeEnabled();
  });
});

// The board ticks all three; a stranger who skipped the model step must not
// be told a model is selected and then meet "no model" on the first message.
describe('the last board', () => {
  it('says what is still missing instead of ticking it', async () => {
    useModel.setState({ cloudModel: null, loaded: null });
    renderLast();
    expect(await screen.findByText('Pick a model in Models')).toBeInTheDocument();
    expect(screen.getByText('Connect apps in Settings')).toBeInTheDocument();
    expect(screen.getByText('Workspace ready')).toBeInTheDocument();
  });

  it('ticks the model once one will answer', async () => {
    useModel.setState({ cloudModel: { providerId: 'openai', providerName: 'OpenAI', modelId: 'gpt-4o' } });
    renderLast();
    expect(await screen.findByText('Model selected')).toBeInTheDocument();
  });
});
