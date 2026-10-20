import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const setMode = vi.hoisted(() => vi.fn());
vi.mock('@/lib/tauri', () => ({ tauri: { settings: { setPermissionMode: setMode } } }));
import { useSettings } from '@/stores/settings';
import { useNotifications } from '@/stores/notifications';
import type { Settings } from '@/lib/tauri';
import { PermissionPill } from '../PermissionPill';

const withMode = (permission_mode?: Settings['permission_mode']) =>
  useSettings.setState({ settings: { permission_mode } as Settings });

beforeEach(() => { setMode.mockReset(); useNotifications.setState({ toasts: [] }); });
afterEach(cleanup);

describe('what Cinderpaw may do, under the composer', () => {
  it('says the default when nobody chose: it can edit files', () => {
    withMode(undefined);
    render(<PermissionPill />);
    expect(screen.getByRole('button', { name: 'What Cinderpaw may do: Can edit files' })).toBeInTheDocument();
  });

  it('switches mode and every choice says what it does', async () => {
    withMode('workspace_write');
    setMode.mockResolvedValue(undefined);
    render(<PermissionPill />);
    await userEvent.click(screen.getByRole('button', { name: /What Cinderpaw may do/ }));
    expect(screen.getByText('Reads files and the web. Changes nothing on this computer.')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Look only'));
    expect(setMode).toHaveBeenCalledWith('read_only');
    await waitFor(() => expect(useSettings.getState().settings?.permission_mode).toBe('read_only'));
  });

  it('a refused change keeps the old mode and says why on screen', async () => {
    withMode('workspace_write');
    setMode.mockRejectedValue('CINDERPAW_PERMISSION_MODE was set when Cinderpaw started, and it decides.');
    render(<PermissionPill />);
    await userEvent.click(screen.getByRole('button', { name: /What Cinderpaw may do/ }));
    await userEvent.click(screen.getByText('Full access'));
    await waitFor(() => expect(JSON.stringify(useNotifications.getState().toasts)).toContain('it decides'));
    expect(useSettings.getState().settings?.permission_mode).toBe('workspace_write');
  });
});
