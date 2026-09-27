import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MemoryLayersPage from '../MemoryLayersPage';
import { tauri, type MemoryNotesLine } from '@/lib/tauri';

vi.mock('@/lib/tauri', async (orig) => {
  const actual = await orig<typeof import('@/lib/tauri')>();
  return {
    ...actual,
    tauri: {
      ...actual.tauri,
      memory: {
        ...actual.tauri.memory,
        getGraph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
        notes: vi.fn(),
      },
      rsi: {
        ...actual.tauri.rsi,
        dreamTelemetry: vi.fn().mockResolvedValue({ episodes: 0, ratchets: 0, tokens: 0, iterations: 0, last: [] }),
        status: vi.fn().mockResolvedValue(null),
      },
    },
  };
});

const notes = tauri.memory.notes as unknown as ReturnType<typeof vi.fn>;
const quiet = { lastOkAt: null, failures: 0, lastError: null };

function reply(over: Partial<MemoryNotesLine> = {}): MemoryNotesLine {
  return {
    type: 'memory_notes_result', id: 'x', ok: true, card: null, notes: [],
    health: { observer: quiet, reflector: quiet }, ...over,
  };
}

beforeEach(() => notes.mockReset());
afterEach(cleanup);

describe('What Cinderpaw remembers', () => {
  it('shows the card, the notes with their dates, and a working Delete', async () => {
    notes.mockResolvedValueOnce(reply({
      card: 'Darius builds Cinderpaw.',
      notes: [{ id: 7, observedAt: Date.UTC(2026, 8, 24, 12), refDate: '2026-10-12', priority: 'high', text: 'Flight to Lisbon', source: 'observer' }],
      health: { observer: { lastOkAt: Date.now() - 2 * 3_600_000, failures: 0, lastError: null }, reflector: quiet },
    }));
    render(<MemoryLayersPage />);
    expect(await screen.findByText('Darius builds Cinderpaw.')).toBeInTheDocument();
    expect(screen.getByText('Flight to Lisbon')).toBeInTheDocument();
    expect(screen.getByText('for 2026-10-12')).toBeInTheDocument();
    expect(screen.getByText(/Last note: 2h ago/)).toBeInTheDocument();

    notes.mockResolvedValueOnce(reply());
    fireEvent.click(screen.getByRole('button', { name: 'Delete note: Flight to Lisbon' }));
    await waitFor(() => expect(screen.queryByText('Flight to Lisbon')).not.toBeInTheDocument());
    expect(notes).toHaveBeenLastCalledWith('delete', 7);
  });

  it('says on screen why no notes are being written', async () => {
    notes.mockResolvedValueOnce(reply({
      health: {
        observer: { lastOkAt: null, failures: 3, lastError: 'the model did not write notes in the expected format' },
        reflector: quiet,
      },
    }));
    render(<MemoryLayersPage />);
    expect(await screen.findByText(/Could not write notes: the model did not write notes in the expected format/)).toBeInTheDocument();
  });

  it('a fresh install explains when the summary will appear', async () => {
    notes.mockResolvedValueOnce(reply());
    render(<MemoryLayersPage />);
    expect(await screen.findByText(/No summary yet/)).toBeInTheDocument();
    expect(screen.getByText('No notes yet.')).toBeInTheDocument();
  });
});
