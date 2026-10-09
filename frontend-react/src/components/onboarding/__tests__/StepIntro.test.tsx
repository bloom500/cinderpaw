import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { StepIntro, OnboardingWizard } from '../OnboardingWizard';
import { cubbyVoiceUrl } from '@/voice/cubbyVoice';
import { tauri } from '@/lib/tauri';
import { useOnboarding } from '@/stores/onboarding';

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

// Steps that render with the light mocks above. Provider (2) and Connect (3)
// are pinned in their own test files, which already carry the mocks they need.
describe.each([
  [0, 'onboarding.welcome'],
  [1, 'onboarding.names'],
  [4, 'onboarding.workspace'],
  [5, 'onboarding.done'],
] as const)('step %i', (step, line) => {
  it(`asks for ${line}`, () => {
    useOnboarding.setState({ active: true, step, userName: 'Ana', agentName: 'Cinderpaw' });
    render(<MemoryRouter><OnboardingWizard /></MemoryRouter>);
    expect(cubbyVoiceUrl).toHaveBeenCalledWith(line);
  });
});
