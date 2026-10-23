/**
 * request_secret in the desktop app: the card saves the value itself and
 * answers only "Saved" / "Cancel"; the value never goes back to the agent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AskUserCard } from '../AskUserCard';
import { tauri } from '@/lib/tauri';
import type { AskUserQuestion } from '@/stores/askUser';

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return {
    ...actual,
    tauri: {
      ...actual.tauri,
      connectors: { ...actual.tauri.connectors, saveSecret: vi.fn() },
      mcp: { ...actual.tauri.mcp, installCustom: vi.fn() },
    },
  };
});

const saveSecret = vi.mocked(tauri.connectors.saveSecret);
const installCustom = vi.mocked(tauri.mcp.installCustom);

const ask = (secret: AskUserQuestion['secret']): AskUserQuestion[] => [
  {
    question: 'Your key',
    header: 'Secret',
    options: [{ label: 'Saved' }, { label: 'Cancel' }],
    multiSelect: false,
    secret,
  },
];

beforeEach(() => vi.clearAllMocks());

describe('the secret field', () => {
  it('saves a connector secret here and answers only "Saved"', async () => {
    saveSecret.mockResolvedValue(undefined);
    const onSubmit = vi.fn();
    render(<AskUserCard requestId="r1" questions={ask({ connector: 'discord', field: 'DISCORD_TOKEN' })} onSubmit={onSubmit} />);
    expect(screen.queryByText('Saved')).toBeNull(); // no option buttons
    await userEvent.type(screen.getByLabelText('Secret value'), 'tok-123');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(saveSecret).toHaveBeenCalledWith('discord', 'DISCORD_TOKEN', 'tok-123');
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith([{ question: 'Your key', selected: ['Saved'] }]));
    expect(JSON.stringify(onSubmit.mock.calls)).not.toContain('tok-123');
  });

  it("connects a service by its link; a refused key stays on the card with the reason", async () => {
    installCustom.mockRejectedValueOnce('That service did not accept the key.').mockResolvedValueOnce({} as never);
    const onSubmit = vi.fn();
    render(<AskUserCard requestId="r2" questions={ask({ extensionUrl: 'https://mcp.publora.com/', extensionName: 'Publora' })} onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText('Secret value'), 'sk_bad');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('That service did not accept the key.')).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.clear(screen.getByLabelText('Secret value'));
    await userEvent.type(screen.getByLabelText('Secret value'), 'sk_good');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(installCustom).toHaveBeenLastCalledWith('Publora', 'https://mcp.publora.com/', 'sk_good');
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith([{ question: 'Your key', selected: ['Saved'] }]));
  });

  it('"Not now" answers Cancel and saves nothing', async () => {
    const onSubmit = vi.fn();
    render(<AskUserCard requestId="r3" questions={ask({ connector: 'discord', field: 'DISCORD_TOKEN' })} onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(saveSecret).not.toHaveBeenCalled();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith([{ question: 'Your key', selected: ['Cancel'] }]));
  });
});
