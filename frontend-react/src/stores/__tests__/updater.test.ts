import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: vi.fn(),
}));

import { useUpdater } from '@/stores/updater';
import { check } from '@tauri-apps/plugin-updater';

const mockCheck = vi.mocked(check);

const reset = () =>
  useUpdater.setState({ status: 'idle', info: null, progress: 0, error: null });

describe('useUpdater store', () => {
  beforeEach(() => { reset(); vi.clearAllMocks(); });

  it('check() with an available update sets status=available and info', async () => {
    mockCheck.mockResolvedValue({
      version: '0.1.2',
      body: 'Shiny new things',
      downloadAndInstall: vi.fn(),
    } as any);

    await useUpdater.getState().check();

    expect(useUpdater.getState().status).toBe('available');
    expect(useUpdater.getState().info).toEqual({ version: '0.1.2', notes: 'Shiny new things' });
  });

  it('check() with no update sets status=up-to-date', async () => {
    mockCheck.mockResolvedValue(null as any);

    await useUpdater.getState().check();

    expect(useUpdater.getState().status).toBe('up-to-date');
    expect(useUpdater.getState().info).toBeNull();
  });

  it('check() failure sets status=error with message', async () => {
    mockCheck.mockRejectedValue(new Error('network down'));

    await useUpdater.getState().check();

    expect(useUpdater.getState().status).toBe('error');
    expect(useUpdater.getState().error).toContain('network down');
  });

  it('dismiss() returns status to idle', () => {
    useUpdater.setState({ status: 'available', info: { version: '0.1.2', notes: null } });
    useUpdater.getState().dismiss();
    expect(useUpdater.getState().status).toBe('idle');
  });
});
