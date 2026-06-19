import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HardwareTab } from '@/components/settings/HardwareTab';
import { useSettings } from '@/stores/settings';
import { useSystemInfo } from '@/stores/systemInfo';

vi.mock('@/stores/settings',  () => ({ useSettings:  vi.fn() }));
vi.mock('@/stores/systemInfo', () => ({ useSystemInfo: vi.fn() }));

const mockUseSettings  = vi.mocked(useSettings);
const mockUseSystemInfo = vi.mocked(useSystemInfo);

const mockSave   = vi.fn().mockResolvedValue(undefined);
const mockUpdate = vi.fn();

const baseSettings = {
  models_dir: '/m', default_gpu_layers: 100,
  api_server_enabled: false, api_port: 11435, version: '0.1.0',
  desktop_control_enabled: false, desktop_control_yolo: false,
  token_budget_conversation: null, rsi_max_cost_usd: 0,
};

function setupStore(overrides: Partial<typeof baseSettings> = {}, saved = false) {
  mockUseSettings.mockImplementation((sel: any) =>
    sel({ settings: { ...baseSettings, ...overrides }, updateSettings: mockUpdate, save: mockSave, saved, saving: false })
  );
  mockUseSystemInfo.mockImplementation((sel: any) =>
    sel({ info: null, loading: false, fetch: vi.fn() })
  );
}

describe('HardwareTab', () => {
  beforeEach(() => { vi.clearAllMocks(); setupStore(); });

  it('toggle OFF calls updateSettings with default_gpu_layers: 0', async () => {
    render(<HardwareTab />);
    await userEvent.click(screen.getByRole('switch'));
    expect(mockUpdate).toHaveBeenCalledWith({ default_gpu_layers: 0 });
  });

  it('toggle ON (when currently 0) calls updateSettings with 100', async () => {
    setupStore({ default_gpu_layers: 0 });
    render(<HardwareTab />);
    await userEvent.click(screen.getByRole('switch'));
    expect(mockUpdate).toHaveBeenCalledWith({ default_gpu_layers: 100 });
  });

  it('Save button calls store.save', async () => {
    render(<HardwareTab />);
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(mockSave).toHaveBeenCalled();
  });

  it('shows ✓ Saved text when saved=true', () => {
    setupStore({}, true);
    render(<HardwareTab />);
    expect(screen.getByText('✓ Saved')).toBeInTheDocument();
  });
});
