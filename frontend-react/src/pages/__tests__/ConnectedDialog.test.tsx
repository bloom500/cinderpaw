import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ConnectedDialog } from '../ExtensionsPage';
import { tauri } from '@/lib/tauri';

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return { ...actual, tauri: { ...actual.tauri, mcp: { ...actual.tauri.mcp, listTools: vi.fn() } } };
});

describe('ConnectedDialog', () => {
  it('says the service is connected and what it can do now', async () => {
    vi.mocked(tauri.mcp.listTools).mockResolvedValue(
      ['search_pages', 'create_page', 'update_page', 'get_comments'].map((name) => ({ name, description: '' })),
    );
    const server = { id: 'custom-mcp-notion-com', name: 'Notion' } as never;
    render(<MemoryRouter><ConnectedDialog server={server} onClose={() => {}} /></MemoryRouter>);
    expect(screen.getByText('Notion is connected')).toBeTruthy();
    expect(await screen.findByText('Cinderpaw can now use 4 of its tools. Just ask for it in any chat.')).toBeTruthy();
    expect(screen.getByText('Search pages')).toBeTruthy();
    expect(screen.getByText('+1 more')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try it in a chat' })).toBeTruthy();
  });
});
