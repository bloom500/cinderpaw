import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ByokTab } from '@/components/settings/ByokTab';
import { useSettings } from '@/stores/settings';

vi.mock('@/stores/settings', () => ({ useSettings: vi.fn() }));
const mockUseSettings = vi.mocked(useSettings);

const mockSaveByok = vi.fn();
const mockTestByok = vi.fn();

function setupStore(byok: object[] = []) {
  mockUseSettings.mockImplementation((sel: any) =>
    sel({ byok, saveByokProvider: mockSaveByok, testByokProvider: mockTestByok })
  );
}

describe('ByokTab', () => {
  beforeEach(() => { vi.clearAllMocks(); setupStore(); });

  it('renders all 11 provider rows', () => {
    render(<ByokTab />);
    expect(screen.getByText('OpenAI')).toBeInTheDocument();
    expect(screen.getByText('Anthropic')).toBeInTheDocument();
    expect(screen.getByText('Google Gemini')).toBeInTheDocument();
    expect(screen.getByText('Kimi')).toBeInTheDocument();
    expect(screen.getByText('GLM (Z.ai)')).toBeInTheDocument();
    expect(screen.getByText('MiniMax')).toBeInTheDocument();
    expect(screen.getByText('DeepSeek')).toBeInTheDocument();
    expect(screen.getByText('Groq')).toBeInTheDocument();
    expect(screen.getByText('Mistral')).toBeInTheDocument();
    expect(screen.getByText('OpenRouter')).toBeInTheDocument();
    expect(screen.getByText('Custom Endpoint')).toBeInTheDocument();
  });

  it('unconfigured providers show "Not configured" badge', () => {
    render(<ByokTab />);
    expect(screen.getAllByText('Not configured')).toHaveLength(11);
  });

  it('enabled provider with has_api_key=true shows "Active" badge', () => {
    setupStore([{ id: 'openai', name: 'OpenAI', provider: 'openai', enabled: true, has_api_key: true }]);
    render(<ByokTab />);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('expanding a row and clicking Save calls saveByokProvider with correct providerId', async () => {
    mockSaveByok.mockResolvedValue(undefined);
    render(<ByokTab />);
    await userEvent.click(screen.getByText('Anthropic'));
    const saveBtn = await screen.findByRole('button', { name: /^save$/i });
    await userEvent.click(saveBtn);
    expect(mockSaveByok).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'anthropic' }));
  });

  it('Test button calls testByokProvider and shows ✓ Connected on success', async () => {
    mockTestByok.mockResolvedValue({ ok: true });
    render(<ByokTab />);
    await userEvent.click(screen.getByText('OpenAI'));
    const keyInput = await screen.findByPlaceholderText('sk-...');
    await userEvent.type(keyInput, 'sk-validkey');
    await userEvent.click(screen.getByRole('button', { name: /^test$/i }));
    await waitFor(() => expect(screen.getByText('✓ Connected')).toBeInTheDocument());
  });

  it('Test button shows error message on failure', async () => {
    mockTestByok.mockResolvedValue({ ok: false, error: 'Invalid API key' });
    render(<ByokTab />);
    await userEvent.click(screen.getByText('OpenAI'));
    const keyInput = await screen.findByPlaceholderText('sk-...');
    await userEvent.type(keyInput, 'sk-bad');
    await userEvent.click(screen.getByRole('button', { name: /^test$/i }));
    await waitFor(() => expect(screen.getByText(/Invalid API key/)).toBeInTheDocument());
  });

  it('MiniMax row shows a model <select> with MiniMax-M3 preselected', async () => {
    render(<ByokTab />);
    await userEvent.click(screen.getByText('MiniMax'));
    const select = await screen.findByRole('combobox');
    expect(select).toHaveValue('MiniMax-M3');
    const options = within(select as HTMLSelectElement).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'MiniMax-M3',
      'MiniMax-M2.7',
      'MiniMax-M2.7-highspeed',
      'MiniMax-M2.5',
      'MiniMax-M2.5-highspeed',
    ]);
  });

  it('GLM row shows a model <select> with glm-5.1 as first option', async () => {
    render(<ByokTab />);
    await userEvent.click(screen.getByText('GLM (Z.ai)'));
    const select = await screen.findByRole('combobox');
    expect(select).toHaveValue('glm-5.1');
  });

  it('Kimi shows key-detected hint when key starts with sk-kimi-', async () => {
    render(<ByokTab />);
    await userEvent.click(screen.getByText('Kimi'));
    const keyInput = await screen.findByPlaceholderText('sk-...');
    await userEvent.type(keyInput, 'sk-kimi-abc123');
    expect(screen.getByText('✓ Kimi key detected')).toBeInTheDocument();
  });

  it('MiniMax shows key-detected hint when key starts with sk-cp-', async () => {
    render(<ByokTab />);
    await userEvent.click(screen.getByText('MiniMax'));
    const keyInput = await screen.findByPlaceholderText('sk-...');
    await userEvent.type(keyInput, 'sk-cp-tokenplan');
    expect(screen.getByText('✓ MiniMax key detected')).toBeInTheDocument();
  });

  it('MiniMax does not show hint for non-MiniMax key', async () => {
    render(<ByokTab />);
    await userEvent.click(screen.getByText('MiniMax'));
    const keyInput = await screen.findByPlaceholderText('sk-...');
    await userEvent.type(keyInput, 'sk-other-key');
    expect(screen.queryByText('✓ MiniMax key detected')).not.toBeInTheDocument();
  });
});
