import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ByokTab } from '@/components/settings/ByokTab';
import { useSettings } from '@/stores/settings';

vi.mock('@/stores/settings', () => ({ useSettings: vi.fn() }));
const mockUseSettings = vi.mocked(useSettings);

const mockSaveByok = vi.fn();
const mockTestByok = vi.fn();

/** A provider's name as the card shows it. The logo beside it carries the same
 *  name in its SVG <title>, which is not text anyone reads on the card. */
const text = (t: string) => screen.getByText(t, { ignore: 'script, style, title' });

function setupStore(byok: object[] = []) {
  mockUseSettings.mockImplementation((sel: any) =>
    sel({ byok, saveByokProvider: mockSaveByok, testByokProvider: mockTestByok })
  );
}

describe('ByokTab', () => {
  beforeEach(() => { vi.clearAllMocks(); setupStore(); });

  it('renders all 12 provider rows, the OpenAI key card when asked for', async () => {
    render(<ByokTab />);
    // The ChatGPT plan card stands where OpenAI's key card was (1 Nov).
    expect(screen.queryByText('OpenAI', { ignore: 'script, style, title' })).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Use an API key instead' }));
    expect(text('OpenAI')).toBeInTheDocument();
    expect(text('Anthropic')).toBeInTheDocument();
    expect(text('Google Gemini')).toBeInTheDocument();
    expect(text('Kimi Code')).toBeInTheDocument();
    expect(text('GLM (Z.ai)')).toBeInTheDocument();
    expect(text('MiniMax')).toBeInTheDocument();
    expect(text('DeepSeek')).toBeInTheDocument();
    expect(text('Groq')).toBeInTheDocument();
    expect(text('Mistral')).toBeInTheDocument();
    expect(text('OpenRouter')).toBeInTheDocument();
    expect(text('NVIDIA NIM')).toBeInTheDocument();
    expect(text('Custom Endpoint')).toBeInTheDocument();
  });

  it('unconfigured providers show "Not configured" badge', () => {
    render(<ByokTab />);
    // Eleven key cards; OpenAI's waits behind the ChatGPT plan card.
    expect(screen.getAllByText('Not configured')).toHaveLength(11);
  });

  it('enabled provider with has_api_key=true shows as connected, with its key added', () => {
    setupStore([{ id: 'openai', name: 'OpenAI', provider: 'openai', enabled: true, has_api_key: true }]);
    render(<ByokTab />);
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('API key added')).toBeInTheDocument();
    // Connected providers leave the "add another" list.
    expect(screen.getAllByText('Not configured')).toHaveLength(11);
  });

  it('a key that is saved but switched off says so', () => {
    setupStore([{ id: 'groq', name: 'Groq', provider: 'groq', enabled: false, has_api_key: true }]);
    render(<ByokTab />);
    expect(screen.getByText('Turned off')).toBeInTheDocument();
  });

  it('expanding a row and clicking Save calls saveByokProvider with correct providerId', async () => {
    mockSaveByok.mockResolvedValue(undefined);
    render(<ByokTab />);
    await userEvent.click(text('Anthropic'));
    const saveBtn = await screen.findByRole('button', { name: /^save$/i });
    await userEvent.click(saveBtn);
    expect(mockSaveByok).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'anthropic' }));
  });

  it('a first key turns the provider on: saved means it answers', async () => {
    mockSaveByok.mockResolvedValue(undefined);
    render(<ByokTab />);
    await userEvent.click(screen.getByRole('button', { name: 'Use an API key instead' }));
    await userEvent.type(await screen.findByPlaceholderText('sk-...'), 'sk-first');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(mockSaveByok).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'openai', enabled: true }));
  });

  it('Test button calls testByokProvider and shows ✓ Connected on success', async () => {
    // This mocks the STORE method, which normalises Rust's
    // { success, message } into { ok, error } — mock that shape, not the raw
    // Tauri one, or the test drifts from what the component actually reads.
    mockTestByok.mockResolvedValue({ ok: true });
    render(<ByokTab />);
    await userEvent.click(screen.getByRole('button', { name: 'Use an API key instead' }));
    const keyInput = await screen.findByPlaceholderText('sk-...');
    await userEvent.type(keyInput, 'sk-validkey');
    await userEvent.click(screen.getByRole('button', { name: /^test$/i }));
    await waitFor(() => expect(screen.getByText('✓ Connected')).toBeInTheDocument());
  });

  it('Test button shows error message on failure', async () => {
    mockTestByok.mockResolvedValue({ ok: false, error: 'Invalid API key' });
    render(<ByokTab />);
    await userEvent.click(screen.getByRole('button', { name: 'Use an API key instead' }));
    const keyInput = await screen.findByPlaceholderText('sk-...');
    await userEvent.type(keyInput, 'sk-bad');
    await userEvent.click(screen.getByRole('button', { name: /^test$/i }));
    await waitFor(() => expect(screen.getByText(/Invalid API key/)).toBeInTheDocument());
  });

  it('Save button surfaces the Rust error message verbatim on failure', async () => {
    // Previously the component swallowed the error with a bare `catch {}`
    // and showed a generic "Save failed" — this made the "Save Failed" bug
    // reported on OpenRouter / NVIDIA NIM (2026-08-22) undebuggable.
    mockSaveByok.mockRejectedValue('keychain locked');
    render(<ByokTab />);
    await userEvent.click(screen.getByRole('button', { name: 'Use an API key instead' }));
    const keyInput = await screen.findByPlaceholderText('sk-...');
    await userEvent.type(keyInput, 'sk-key');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() =>
      expect(screen.getByText(/Save failed: keychain locked/)).toBeInTheDocument(),
    );
  });

  it('MiniMax row shows a themed model picker with MiniMax-M3 preselected', async () => {
    render(<ByokTab />);
    await userEvent.click(text('MiniMax'));
    const picker = await screen.findByRole('button', { name: 'Model' });
    expect(picker).toHaveTextContent('MiniMax-M3');
    await userEvent.click(picker);
    const options = await screen.findAllByRole('menuitemradio');
    expect(options.map((o) => o.textContent)).toEqual([
      'MiniMax-M3',
      'MiniMax-M2.7',
      'MiniMax-M2.7-highspeed',
      'MiniMax-M2.5',
      'MiniMax-M2.5-highspeed',
    ]);
    expect(options[0]).toHaveAttribute('aria-checked', 'true');
  });

  it('GLM row shows a model picker with glm-5.1 first', async () => {
    render(<ByokTab />);
    await userEvent.click(text('GLM (Z.ai)'));
    expect(await screen.findByRole('button', { name: 'Model' })).toHaveTextContent('glm-5.1');
  });

  it('Kimi shows key-detected hint when key starts with sk-kimi-', async () => {
    render(<ByokTab />);
    await userEvent.click(text('Kimi Code'));
    const keyInput = await screen.findByPlaceholderText('sk-...');
    await userEvent.type(keyInput, 'sk-kimi-abc123');
    expect(screen.getByText('✓ Kimi Code key detected')).toBeInTheDocument();
  });

  it('MiniMax shows key-detected hint when key starts with sk-cp-', async () => {
    render(<ByokTab />);
    await userEvent.click(text('MiniMax'));
    const keyInput = await screen.findByPlaceholderText('sk-...');
    await userEvent.type(keyInput, 'sk-cp-tokenplan');
    expect(screen.getByText('✓ MiniMax key detected')).toBeInTheDocument();
  });

  it('MiniMax does not show hint for non-MiniMax key', async () => {
    render(<ByokTab />);
    await userEvent.click(text('MiniMax'));
    const keyInput = await screen.findByPlaceholderText('sk-...');
    await userEvent.type(keyInput, 'sk-other-key');
    expect(screen.queryByText('✓ MiniMax key detected')).not.toBeInTheDocument();
  });
});

// 1 Nov, Darius: a ChatGPT plan instead of an API key, in the same list.
describe('ByokTab OpenAI Subscription', () => {
  it('offers ChatGPT sign-in with no key, and shows the plan in use once signed in', () => {
    setupStore();
    const { unmount } = render(<ByokTab />);
    expect(screen.getByRole('button', { name: 'Continue with ChatGPT' })).toBeInTheDocument();
    unmount();

    setupStore([{ id: 'chatgpt', name: 'OpenAI Subscription', provider: 'openai', enabled: true, has_api_key: true, default_model: 'gpt-6.1-sol' }]);
    render(<ByokTab />);
    expect(screen.queryByRole('button', { name: 'Continue with ChatGPT' })).toBeNull();
    expect(screen.getByText('Using your ChatGPT plan')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Manage usage' }).getAttribute('href')).toBe('https://chatgpt.com/settings/usage');
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });
});

// 1 Nov, Darius: the plan where OpenAI's key card stood; Anthropic heads the keys, OpenAI's key goes last.
describe('ByokTab order', () => {
  it('lists the ChatGPT plan first, then Anthropic, and the OpenAI key last', () => {
    setupStore([
      { id: 'openai', name: 'OpenAI', provider: 'openai', enabled: true, has_api_key: true },
      { id: 'anthropic', name: 'Anthropic', provider: 'anthropic', enabled: true, has_api_key: true },
      { id: 'chatgpt', name: 'OpenAI Subscription', provider: 'openai', enabled: true, has_api_key: true, default_model: 'gpt-6.1-sol' },
    ]);
    render(<ByokTab />);
    const names = [...document.querySelectorAll('article')].map((a) => a.querySelector('.text-lg')?.textContent);
    expect(names.slice(0, 3)).toEqual(['OpenAI Subscription', 'Anthropic', 'OpenAI']);
  });
});
