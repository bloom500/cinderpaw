import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

  it('renders all 6 provider rows', () => {
    render(<ByokTab />);
    expect(screen.getByText('OpenAI')).toBeInTheDocument();
    expect(screen.getByText('Anthropic')).toBeInTheDocument();
    expect(screen.getByText('Google Gemini')).toBeInTheDocument();
    expect(screen.getByText('Groq')).toBeInTheDocument();
    expect(screen.getByText('Mistral')).toBeInTheDocument();
    expect(screen.getByText('Custom Endpoint')).toBeInTheDocument();
  });

  it('unconfigured providers show "Not configured" badge', () => {
    render(<ByokTab />);
    expect(screen.getAllByText('Not configured')).toHaveLength(6);
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
});
