import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ConnectedDialog } from '../ConnectedDialog';
import { useConnected } from '@/stores/connected';
import { tauri } from '@/lib/tauri';

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return { ...actual, tauri: { ...actual.tauri, mcp: { ...actual.tauri.mcp, listTools: vi.fn() } } };
});

const mount = () => render(<MemoryRouter><ConnectedDialog /></MemoryRouter>);

beforeEach(() => act(() => useConnected.getState().close()));

describe('ConnectedDialog', () => {
  it('a service: says it is connected, what it can do, and offers a chat', async () => {
    vi.mocked(tauri.mcp.listTools).mockResolvedValue(
      ['search_pages', 'create_page', 'update_page', 'get_comments'].map((name) => ({ name, description: '' })),
    );
    mount();
    act(() => useConnected.getState().show({ name: 'Notion', mcpId: 'custom-mcp-notion-com', prompt: 'What can you do in Notion?' }));
    expect(screen.getByText('Notion is connected')).toBeTruthy();
    expect(await screen.findByText('Cinderpaw can now use 4 of its tools. Just ask for it in any chat.')).toBeTruthy();
    expect(screen.getByText('Search pages')).toBeTruthy();
    expect(screen.getByText('+1 more')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try it in a chat' })).toBeTruthy();
  });

  it('a chat app: its own line, and no chat button', () => {
    mount();
    act(() => useConnected.getState().show({ name: 'Discord', body: 'Message Cinderpaw on Discord to try it. It answers there.' }));
    expect(screen.getByText('Discord is connected')).toBeTruthy();
    expect(screen.getByText('Message Cinderpaw on Discord to try it. It answers there.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try it in a chat' })).toBeNull();
  });

  it('shows nothing until something connects', () => {
    mount();
    expect(screen.queryByText(/is connected/)).toBeNull();
  });
});
