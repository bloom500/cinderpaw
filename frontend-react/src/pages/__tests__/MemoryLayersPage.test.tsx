import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryLayersPage } from '@/pages/MemoryLayersPage';
import { tauri } from '@/lib/tauri';

beforeEach(() => {
  vi.spyOn(tauri.memory, 'getGraph').mockResolvedValue({
    nodes: [{ id: 'a', label: 'Alpha', type: 'entity', touched_at: 1 }],
    edges: [],
  });
});

describe('MemoryLayersPage', () => {
  it('renders the control panel title and loads the graph', async () => {
    render(<MemoryLayersPage />);
    expect(await screen.findByText('Memory Layers')).toBeInTheDocument();
    await waitFor(() => expect(tauri.memory.getGraph).toHaveBeenCalled());
  });
});
