import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { OnboardingWizard } from '../OnboardingWizard';
import { tauri } from '@/lib/tauri';
import { useOnboarding } from '@/stores/onboarding';
import { useModel } from '@/stores/model';
import { useDownload } from '@/stores/download';
import { useSettings } from '@/stores/settings';

vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

const OPENAI = { providerId: 'openai', providerName: 'OpenAI', modelId: 'gpt-4o' };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(tauri.mcp, 'list').mockResolvedValue([]);
  vi.spyOn(tauri.connectors, 'list').mockResolvedValue([]);
  vi.spyOn(tauri.raw, 'setupDetect').mockResolvedValue([]);
  vi.spyOn(tauri.system, 'countInstall').mockResolvedValue(undefined as never);
  vi.spyOn(tauri.system, 'setUsageSharing').mockResolvedValue(undefined as never);
  useModel.setState({ cloudModel: null, loaded: null });
  useDownload.setState({ active: null, done: false });
  useSettings.setState({ byok: [] });
  useOnboarding.setState({ active: true, step: 2, brainVerified: false, firstTask: null, userName: '', agentName: 'Cinderpaw' });
});

const renderWizard = () => render(<MemoryRouter><OnboardingWizard /></MemoryRouter>);

describe('the welcome card', () => {
  it('plays the film without sound, and one button turns the music on', () => {
    useOnboarding.setState({ step: 0 });
    const { container } = renderWizard();
    const video = container.querySelector('video')!;
    // WebM first for Linux webviews, MP4 for the rest.
    expect([...video.querySelectorAll('source')].map((s) => s.type)).toEqual(['video/webm', 'video/mp4']);
    expect(video.muted).toBe(true);
    // The path starts with the install already done, not at zero.
    expect(screen.getByLabelText('Installed. Step 1 of 3')).toBeInTheDocument();
    const sound = screen.getByRole('button', { name: /Sound on/ });
    fireEvent.click(sound);
    expect(video.muted).toBe(false);
    expect(screen.getByRole('button', { name: /Sound off/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('opens over the whole screen, and Esc brings it back', () => {
    useOnboarding.setState({ step: 0 });
    renderWizard();
    fireEvent.click(screen.getByRole('button', { name: /Full screen/ }));
    const big = screen.getByRole('dialog', { name: 'Your AI team, full screen' });
    expect(big.querySelector('video')).toHaveAttribute('controls');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Your AI team, full screen' })).not.toBeInTheDocument();
  });
});

// A stranger must not click through to a chat that answers "no model", and a
// Continue that does nothing must say why and leave a way on.
describe('the brain card', () => {
  it('holds Continue until something will answer, and says how to go on anyway', () => {
    useOnboarding.setState({ step: 1 });
    renderWizard();
    expect(screen.getByRole('button', { name: /Continue/ })).toBeDisabled();
    expect(screen.getByText(/Pick one way above so I can answer you/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'skip for now' }));
    expect(useOnboarding.getState().step).toBe(2);
  });

  it('lets you on once a model will answer', () => {
    useOnboarding.setState({ step: 1 });
    useModel.setState({ cloudModel: OPENAI });
    renderWizard();
    expect(screen.getByRole('button', { name: /Continue/ })).toBeEnabled();
    expect(screen.queryByText(/Pick one way above/)).not.toBeInTheDocument();
  });

  it('counts a download on its way, it will answer when it lands', () => {
    useOnboarding.setState({ step: 1 });
    useDownload.setState({ active: { repoId: 'r', filename: 'f', progress: 0.2 } as never });
    renderWizard();
    expect(screen.getByRole('button', { name: /Continue/ })).toBeEnabled();
  });
});

describe('the last card', () => {
  it('says what is still missing instead of "ready", one click back to the brain card', () => {
    renderWizard();
    expect(screen.getByText('Pick a model so I can answer you.')).toBeInTheDocument();
    expect(screen.queryByText(/What should/)).not.toBeInTheDocument();
    // Alpha is said once, here, with where to report a problem.
    expect(screen.getByText(/still in alpha/)).toHaveTextContent('Report a bug');
    fireEvent.click(screen.getByRole('button', { name: /Choose a model/ }));
    expect(useOnboarding.getState().step).toBe(1);
  });

  it('lets you start without a name', () => {
    useModel.setState({ cloudModel: OPENAI });
    renderWizard();
    expect(screen.getByText('Pick a job, or ask me anything.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Your name/)).toHaveValue('');
    expect(screen.getByRole('button', { name: /Start exploring/ })).toBeEnabled();
  });

  it('a first task closes the wizard and waits in the chat box, unsent', () => {
    useModel.setState({ cloudModel: OPENAI });
    renderWizard();
    fireEvent.click(screen.getByRole('button', { name: /coffee machines/ }));
    expect(useOnboarding.getState().firstTask).toBe('Find the five best-reviewed coffee machines and put them in a table');
    expect(useOnboarding.getState().active).toBe(false);
  });
});

// Optional, nothing picked for them, and only while the install count is on:
// the source rides on that one ping and has no way out of its own.
describe('where did you hear about Cinderpaw', () => {
  it('shows buttons only while the count is ticked, and a click picks one', async () => {
    useOnboarding.setState({ countInstall: true, heardFrom: null });
    renderWizard();
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
