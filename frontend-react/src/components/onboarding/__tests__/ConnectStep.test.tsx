import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConnectStep, pick } from '../ConnectStep';
import { tauri } from '@/lib/tauri';
import { useOnboarding } from '@/stores/onboarding';

vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
// The sprite is a canvas, which jsdom cannot draw.
vi.mock('@/components/chat/mascot/CinderpawMascot', () => ({ CinderpawMascot: () => null }));

const tool = (id: string, name: string) => ({ id, name, description: `${name} things`, category: 'Work', icon: '', fields: [], browser_login: false });
const chat = (id: string, name: string, coming_soon = false) => ({ id, name, description: `${name} chats`, icon: '', fields: [], auth_kind: 'token', coming_soon });

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(tauri.mcp, 'catalog').mockResolvedValue([tool('postgres', 'Postgres'), tool('github', 'GitHub'), tool('notion', 'Notion')] as never);
  vi.spyOn(tauri.mcp, 'list').mockResolvedValue([{ id: 'github' }] as never);
  vi.spyOn(tauri.connectors, 'catalog').mockResolvedValue([
    chat('slack', 'Slack'), chat('discord', 'Discord'), chat('matrix', 'Matrix'), chat('tlon', 'Tlon', true),
  ] as never);
  vi.spyOn(tauri.connectors, 'list').mockResolvedValue([]);
});

describe('ConnectStep', () => {
  it('lists the real integrations, marks what is connected, and pre-selects nothing', async () => {
    render(<ConnectStep />);
    expect(await screen.findByText('Notion')).toBeTruthy();
    // In the spec's order, and only the named presets: Postgres is not offered here.
    expect(screen.queryByText('Postgres')).toBeNull();
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect Notion' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect GitHub' })).toBeNull();
    expect(screen.getByText('Google Docs')).toBeTruthy();
  });

  it('keeps the other chat apps behind "N more", in a window of their own, never one that is coming soon', async () => {
    render(<ConnectStep />);
    await userEvent.click(await screen.findByRole('button', { name: /1 more/ }));
    expect(screen.getByRole('dialog', { name: 'More apps to connect' })).toBeTruthy();
    expect(screen.getByText('Matrix')).toBeTruthy();
    expect(screen.queryByText('Tlon')).toBeNull();
  });

  it('"+" opens the real connect form', async () => {
    render(<ConnectStep />);
    await userEvent.click(await screen.findByRole('button', { name: 'Connect Slack' }));
    expect(screen.getByRole('dialog', { name: 'Connect Slack' })).toBeTruthy();
  });

  it('Skip moves on', async () => {
    const next = vi.fn();
    useOnboarding.setState({ next });
    render(<ConnectStep />);
    await userEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(next).toHaveBeenCalled();
  });

  it('pick keeps the named order', () => {
    expect(pick([{ id: 'b' }, { id: 'a' }, { id: 'c' }], ['a', 'b']).map((x) => x.id)).toEqual(['a', 'b']);
  });
});
