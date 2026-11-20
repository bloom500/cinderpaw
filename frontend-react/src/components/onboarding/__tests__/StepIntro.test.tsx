import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { StepIntro, OnboardingWizard } from '../OnboardingWizard';
import { cubbyVoiceUrl } from '@/voice/cubbyVoice';
import { tauri } from '@/lib/tauri';
import { useOnboarding } from '@/stores/onboarding';
import { useModel } from '@/stores/model';

vi.mock('@/voice/cubbyVoice', () => ({ cubbyVoiceUrl: vi.fn(() => '/a.mp3') }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

beforeEach(() => {
  vi.mocked(cubbyVoiceUrl).mockClear();
  vi.spyOn(tauri.mcp, 'list').mockResolvedValue([]);
  vi.spyOn(tauri.connectors, 'list').mockResolvedValue([]);
});

describe('StepIntro', () => {
  it('has a Listen button when given a line', () => {
    render(<StepIntro title="T" lead="L" body="B" voice="onboarding.welcome" />);
    expect(screen.getByRole('button', { name: 'Listen to Cubby' })).toBeInTheDocument();
  });

  it('has none without one', () => {
    render(<StepIntro title="T" lead="L" body="B" />);
    expect(screen.queryByRole('button', { name: 'Listen to Cubby' })).toBeNull();
  });
});

// Cards that render with the light mocks above. Provider (1) is pinned in its
// own test file, which already carries the mocks it needs.
describe.each([
  [0, 'onboarding.welcome'],
  [2, 'onboarding.done'],
] as const)('step %i', (step, line) => {
  it(`asks for ${line}`, () => {
    useOnboarding.setState({ active: true, step, userName: 'Ana', agentName: 'Cinderpaw' });
    // The done line says "we're all set": it plays only when a model will answer.
    useModel.setState({ cloudModel: { providerId: 'openai', providerName: 'OpenAI', modelId: 'gpt-x' } });
    render(<MemoryRouter><OnboardingWizard /></MemoryRouter>);
    expect(cubbyVoiceUrl).toHaveBeenCalledWith(line);
  });
});
