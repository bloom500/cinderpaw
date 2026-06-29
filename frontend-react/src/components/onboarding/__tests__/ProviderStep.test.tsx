import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ProviderStep } from '@/components/onboarding/OnboardingWizard';
import { useSystemInfo } from '@/stores/systemInfo';
import { useDownload } from '@/stores/download';
import { useSettings } from '@/stores/settings';
import { useOnboarding } from '@/stores/onboarding';

vi.mock('@/stores/systemInfo', () => ({ useSystemInfo: vi.fn() }));
vi.mock('@/stores/download', () => ({ useDownload: vi.fn() }));
vi.mock('@/stores/settings', () => ({ useSettings: vi.fn() }));
vi.mock('@/stores/onboarding', () => ({ useOnboarding: vi.fn() }));

const mockStart = vi.fn();
const mockSave = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  // 12 GB Vulkan VRAM → budget 9600 → recommendModel returns the 7–8B tier.
  vi.mocked(useSystemInfo).mockImplementation((sel: any) =>
    sel({ info: { supports_vulkan: true, vram_total_mb: 12000, ram_total_mb: 32000 }, fetch: vi.fn() }),
  );
  vi.mocked(useDownload).mockImplementation((sel: any) =>
    sel({ active: null, done: false, error: null, start: mockStart }),
  );
  vi.mocked(useSettings).mockImplementation((sel: any) =>
    sel({ saveByokProvider: mockSave, testByokProvider: vi.fn() }),
  );
  vi.mocked(useOnboarding).mockImplementation((sel: any) => sel({ finish: vi.fn() }));
});

const renderStep = () => render(<MemoryRouter><ProviderStep /></MemoryRouter>);

describe('ProviderStep', () => {
  it('renders both fork cards', () => {
    renderStep();
    expect(screen.getByText('Run locally')).toBeInTheDocument();
    expect(screen.getByText('Use a cloud key')).toBeInTheDocument();
  });

  it('local download starts the recommended-tier model with the exact repo + file', async () => {
    renderStep();
    await userEvent.click(screen.getByText('Run locally'));
    await userEvent.click(await screen.findByRole('button', { name: /download qwen3\.5 9b/i }));
    expect(mockStart).toHaveBeenCalledWith(
      'bartowski/Qwen_Qwen3.5-9B-GGUF',
      'Qwen_Qwen3.5-9B-Q4_K_M.gguf',
    );
  });

  it('saving a curated provider calls saveByokProvider with its id (enabled)', async () => {
    mockSave.mockResolvedValue(undefined);
    renderStep();
    await userEvent.click(screen.getByText('Use a cloud key'));
    await userEvent.click(await screen.findByText('OpenAI'));
    await userEvent.type(screen.getByPlaceholderText('sk-...'), 'sk-test');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'openai', enabled: true }),
    );
  });
});
