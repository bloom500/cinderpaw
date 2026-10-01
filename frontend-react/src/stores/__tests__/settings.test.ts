import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/tauri', () => ({
  tauri: {
    settings: {
      get:  vi.fn(),
      save: vi.fn(),
      setDesktopControl: vi.fn(),
      setDesktopControlYolo: vi.fn(),
      setTokenBudget: vi.fn(),
      setRsiBudget: vi.fn(),
    },
    raw: {
      getByokSettings:   vi.fn(),
      saveByokProvider:  vi.fn(),
      testByokProvider:  vi.fn(),
    },
  },
}));

import { useSettings } from '@/stores/settings';
import { useModel } from '@/stores/model';
import { tauri } from '@/lib/tauri';

const mockGet      = vi.mocked(tauri.settings.get);
const mockSave     = vi.mocked(tauri.settings.save);
const mockGetByok  = vi.mocked(tauri.raw.getByokSettings);
const mockSaveByok = vi.mocked(tauri.raw.saveByokProvider);
const mockTestByok = vi.mocked(tauri.raw.testByokProvider);

const sample = {
  models_dir: '/home/.cinderpaw/models',
  default_gpu_layers: 100,
  api_server_enabled: false,
  api_port: 11435,
  version: '0.1.0',
  desktop_control_enabled: false,
  desktop_control_yolo: false,
  token_budget_conversation: null,
  rsi_max_cost_usd: 0,
  rsi_allow_cloud_dreams: false,  dreams_enabled: false,

  active_route: null, cloud_fallback_enabled: false,
};

const reset = () => {
  useSettings.setState({ settings: null, byok: [], loading: false, saving: false, saved: false });
  useModel.setState({ roles: {}, cloudModel: null });
};

describe('useSettings', () => {
  beforeEach(() => { reset(); vi.clearAllMocks(); });

  it('updateSettings patches settings locally without IPC call', () => {
    useSettings.setState({ settings: { ...sample } });
    useSettings.getState().updateSettings({ models_dir: '/new/path' });
    expect(useSettings.getState().settings?.models_dir).toBe('/new/path');
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('fetchSettings populates settings from Tauri', async () => {
    mockGet.mockResolvedValue(sample);
    await useSettings.getState().fetchSettings();
    expect(useSettings.getState().settings).toEqual(sample);
    expect(useSettings.getState().loading).toBe(false);
  });

  it('save calls tauri.settings.save with current settings', async () => {
    useSettings.setState({ settings: sample });
    mockSave.mockResolvedValue(undefined);
    await useSettings.getState().save();
    expect(mockSave).toHaveBeenCalledWith(sample);
    expect(useSettings.getState().saved).toBe(true);
  });

  it('save resets saved flag after 2 s', async () => {
    vi.useFakeTimers();
    useSettings.setState({ settings: sample });
    mockSave.mockResolvedValue(undefined);
    await useSettings.getState().save();
    expect(useSettings.getState().saved).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(useSettings.getState().saved).toBe(false);
    vi.useRealTimers();
  });

  it('fetchByok populates byok array from Tauri', async () => {
    const data = [{ id: 'openai', name: 'OpenAI', provider: 'openai', enabled: true, has_api_key: true, base_url: null, default_model: null }];
    mockGetByok.mockResolvedValue(data as any);
    await useSettings.getState().fetchByok();
    expect(useSettings.getState().byok).toEqual(data);
  });

  it('testByokProvider returns ok:true on success', async () => {
    mockTestByok.mockResolvedValue({ success: true, message: 'Connected' } as any);
    const result = await useSettings.getState().testByokProvider({
      providerId: 'openai', apiKey: 'sk-test', baseUrl: null,
    });
    expect(result.ok).toBe(true);
  });

  it('testByokProvider returns ok:false when Tauri throws', async () => {
    mockTestByok.mockRejectedValue(new Error('Network error'));
    const result = await useSettings.getState().testByokProvider({
      providerId: 'openai', apiKey: 'sk-test', baseUrl: null,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Network error');
  });

  it('testByokProvider returns ok:false with Rust error message on failure', async () => {
    mockTestByok.mockResolvedValue({ success: false, message: 'Invalid API key' } as any);
    const result = await useSettings.getState().testByokProvider({
      providerId: 'openai', apiKey: 'sk-invalid', baseUrl: null,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Invalid API key');
  });

  it("setRsiBudget persists via the tauri command and updates state", async () => {
    useSettings.setState({ settings: { ...sample } });
    const spy = vi.spyOn(tauri.settings, "setRsiBudget").mockResolvedValue(undefined);
    await useSettings.getState().setRsiBudget(2.5);
    expect(spy).toHaveBeenCalledWith(2.5);
    expect(useSettings.getState().settings?.rsi_max_cost_usd).toBe(2.5);
  });

  it('saving a new default model carries it into Roles and the chat', async () => {
    // Models > Cloud says "choose the model each provider answers with".
    // Roles copies that value, so a change made there has to arrive here too,
    // or the user edits the same choice in two places and the two drift.
    const provider = (default_model: string | null) => ({
      id: 'openrouter', name: 'OpenRouter', provider: 'openrouter',
      enabled: true, has_api_key: true, base_url: null, default_model,
    });
    const OLD = 'z-ai/glm-5.3-flash';
    const NEW = 'anthropic/claude-sonnet-4.5';

    mockGetByok.mockResolvedValue([provider(OLD)] as any);
    await useSettings.getState().fetchByok();

    useModel.setState({
      roles: {
        // seeded from the default, so it follows it
        deep: { kind: 'cloud', providerId: 'openrouter', providerName: 'OpenRouter', modelId: OLD },
        // typed by hand, so it does not
        fast: { kind: 'cloud', providerId: 'openrouter', providerName: 'OpenRouter', modelId: 'openrouter/pinned' },
      },
      cloudModel: { providerId: 'openrouter', providerName: 'OpenRouter', modelId: OLD },
    });

    mockSaveByok.mockResolvedValue(undefined);
    mockGetByok.mockResolvedValue([provider(NEW)] as any);
    await useSettings.getState().saveByokProvider({
      providerId: 'openrouter', enabled: true, apiKey: '', baseUrl: null, defaultModel: NEW,
    });

    expect(mockSaveByok).toHaveBeenCalledWith('openrouter', true, '', null, NEW);
    expect(useModel.getState().roles.deep).toEqual(
      { kind: 'cloud', providerId: 'openrouter', providerName: 'OpenRouter', modelId: NEW },
    );
    expect(useModel.getState().roles.fast).toEqual(
      { kind: 'cloud', providerId: 'openrouter', providerName: 'OpenRouter', modelId: 'openrouter/pinned' },
    );
    expect(useModel.getState().cloudModel?.modelId).toBe(NEW);
  });
});

