import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddYourOwnCard } from '../ExtensionsPage';
import { tauri } from '@/lib/tauri';

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return { ...actual, tauri: { ...actual.tauri, mcp: { ...actual.tauri.mcp, installCustom: vi.fn() } } };
});

const install = vi.mocked(tauri.mcp.installCustom);

beforeEach(() => vi.clearAllMocks());

describe('AddYourOwnCard', () => {
  it('sends the link and key, then closes and refreshes the list', async () => {
    install.mockResolvedValue({} as never);
    const onInstalled = vi.fn();
    render(<AddYourOwnCard onInstalled={onInstalled} />);
    await userEvent.click(screen.getByText('Add your own'));
    await userEvent.type(screen.getByPlaceholderText('https://mcp.example.com'), 'https://mcp.publora.com');
    await userEvent.type(screen.getByLabelText(/^Key/), 'sk_1');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(install).toHaveBeenCalledWith('', 'https://mcp.publora.com', 'sk_1');
    await waitFor(() => expect(onInstalled).toHaveBeenCalled());
    expect(screen.queryByPlaceholderText('https://mcp.example.com')).toBeNull();
  });

  it("shows the backend's reason when it does not connect, and keeps what was typed", async () => {
    install.mockRejectedValue('That service did not accept the key.');
    render(<AddYourOwnCard onInstalled={vi.fn()} />);
    await userEvent.click(screen.getByText('Add your own'));
    await userEvent.type(screen.getByPlaceholderText('https://mcp.example.com'), 'https://x.dev/mcp');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('That service did not accept the key.')).toBeTruthy();
    expect((screen.getByPlaceholderText('https://mcp.example.com') as HTMLInputElement).value).toBe('https://x.dev/mcp');
  });
});
