import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
    // The grey button says why, and the preview does not call the person "you".
    expect(screen.getByText('Type your name to continue.')).toBeInTheDocument();
    expect(screen.getByText(/Sure! What can I help you with/)).toBeInTheDocument();
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
    // Not "ready" with nothing to answer, and one click back to the model board.
    expect(screen.queryByText(/ready to explore/)).not.toBeInTheDocument();
    expect(screen.getByText('Pick a model so I can answer you.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Choose a model/ }));
    expect(useOnboarding.getState().step).toBe(2);
  });

  it('ticks the model once one will answer', async () => {
    useModel.setState({ cloudModel: { providerId: 'openai', providerName: 'OpenAI', modelId: 'gpt-4o' } });
    renderLast();
    expect(await screen.findByText('Model selected')).toBeInTheDocument();
  });
});

// Optional, nothing picked for them, and only while the install count is on:
// the source rides on that one ping and has no way out of its own.
describe('where did you hear about Cinderpaw', () => {
  it('shows buttons only while the count is ticked, and a click picks one', async () => {
    useOnboarding.setState({ countInstall: true, heardFrom: null });
    renderLast();
    const reddit = await screen.findByRole('button', { name: 'Reddit' });
    expect(reddit).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(reddit);
    expect(useOnboarding.getState().heardFrom).toBe('reddit');
    fireEvent.click(screen.getByRole('button', { name: 'Reddit' }));
    expect(useOnboarding.getState().heardFrom).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /Count this install/ }));
    expect(screen.queryByRole('button', { name: 'Reddit' })).not.toBeInTheDocument();
  });
});
