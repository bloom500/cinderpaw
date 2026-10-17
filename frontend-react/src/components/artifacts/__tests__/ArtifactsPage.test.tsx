import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ArtifactsPage, filterOf } from '@/pages/ArtifactsPage';
import { useArtifacts, resetArtifactRequests, type ArtifactRow } from '@/stores/artifacts';
import { useConversations } from '@/stores/conversations';
import { tauri } from '@/lib/tauri';

/**
 * The gallery behind the sidebar's Artifacts row. These pin what a stranger
 * meets first: a fresh install is told what will appear and offered one tile,
 * a failed read is not mistaken for a fresh install, and a card opens the same
 * side panel a chat card does.
 */

vi.mock('@/lib/tauri', async (orig) => {
  const actual = await orig<typeof import('@/lib/tauri')>();
  return { ...actual, tauri: { ...actual.tauri, artifacts: { op: vi.fn().mockResolvedValue(undefined) } } };
});
const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

const op = tauri.artifacts.op as unknown as ReturnType<typeof vi.fn>;
const mount = () => render(<MemoryRouter><ArtifactsPage /></MemoryRouter>);

function row(over: Partial<ArtifactRow>): ArtifactRow {
  return { id: 'a1', kind: 'markdown', title: 'Q3 report', version: 1, bytes: 120, updatedAt: Date.now(), modifiedBy: 'chat', ...over };
}

beforeEach(() => {
  resetArtifactRequests();
  op.mockClear();
  navigate.mockClear();
  useArtifacts.setState({ rows: [], loaded: false, open: null, busy: false, error: null, panelOpen: false, showingArchived: false });
  useConversations.setState({ currentId: 'old-chat' } as never);
});
afterEach(cleanup);

describe('ArtifactsPage', () => {
  it('says nothing about an empty list before the first read comes back', () => {
    mount();
    expect(screen.queryByText(/first artifact/)).toBeNull();
    expect(screen.queryByRole('region', { name: 'Make something new' })).toBeNull();
  });

  it('tells a fresh install what will appear, with one tile that starts a chat', () => {
    useArtifacts.setState({ loaded: true });
    mount();
    expect(screen.getByText('Your first artifact will live here')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Make something new' })).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /A plan for this week/ }));
    expect(useConversations.getState().currentId).toBeNull();
    expect(navigate).toHaveBeenCalledWith('/chat', { state: { compose: 'Make me a one-page plan for this week.' } });
  });

  it('does not call a failed read a fresh install', () => {
    useArtifacts.setState({ loaded: true, error: 'sidecar gone' });
    mount();
    expect(screen.getByText(/could not read your artifacts/)).toBeTruthy();
    expect(screen.queryByText(/first artifact/)).toBeNull();
  });

  it('filters by kind and by title', () => {
    useArtifacts.setState({ loaded: true, rows: [
      row({ id: 'd', title: 'Q3 report' }),
      row({ id: 't', kind: 'table', title: 'Leads list' }),
      row({ id: 'p', kind: 'app', title: 'Budget chart' }),
    ] });
    mount();
    fireEvent.click(screen.getByRole('button', { name: /^Tables/ }));
    expect(screen.getByRole('button', { name: /^Leads list/ })).toBeTruthy();
    expect(screen.queryByText('Q3 report')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^All/ }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search artifacts by title' }), { target: { value: '  BUDGET ' } });
    expect(screen.getByRole('button', { name: /^Budget chart/ })).toBeTruthy();
    expect(screen.queryByText('Leads list')).toBeNull();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nothing like it' } });
    expect(screen.getByText('No artifacts match "nothing like it".')).toBeTruthy();
  });

  it('opens a card in the side panel beside the chat', async () => {
    useArtifacts.setState({ loaded: true, rows: [row({ id: 'q3' })] });
    mount();
    fireEvent.click(screen.getByRole('button', { name: /^Q3 report/ }));
    expect(useArtifacts.getState()).toMatchObject({ panelOpen: true, panelTab: 'artifacts' });
    expect(navigate).toHaveBeenCalledWith('/chat');
    await waitFor(() => expect(op.mock.calls.some((c) => c[1] === 'versions' && c[2]?.artifactId === 'q3')).toBe(true));
  });

  it('offers only kinds Cinderpaw can make, each as a ready sentence', () => {
    useArtifacts.setState({ loaded: true, rows: [row({})] });
    mount();
    const tiles = screen.getByRole('region', { name: 'Make something new' });
    expect(tiles.textContent).not.toMatch(/Slides/);
    fireEvent.click(within(tiles).getByRole('button', { name: /^Table/ }));
    expect(navigate).toHaveBeenCalledWith('/chat', { state: { compose: 'Make me a table of ' } });
  });

  it('files every kind under a filter, new ones under Files', () => {
    expect(['markdown', 'document', 'docx', 'pdf'].map(filterOf)).toEqual(Array(4).fill('documents'));
    expect(['app', 'html', 'board'].map(filterOf)).toEqual(Array(3).fill('apps'));
    expect(filterOf('table')).toBe('tables');
    expect(['code', 'json', 'image', 'file', 'something-new'].map(filterOf)).toEqual(Array(5).fill('files'));
  });
});
