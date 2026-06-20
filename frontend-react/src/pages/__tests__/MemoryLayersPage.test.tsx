import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import MemoryLayersPage from '@/pages/MemoryLayersPage';
import { tauri } from '@/lib/tauri';

beforeEach(() => {
  vi.spyOn(tauri.memory, 'getGraph').mockResolvedValue({
    nodes: [{ id: 'a', label: 'Alpha', type: 'entity', touched_at: 1 }],
    edges: [],
  });
});

describe('MemoryLayersPage', () => {
  it('mounts and calls getGraph on load', async () => {
    render(<MemoryLayersPage />);
    await vi.waitFor(() => expect(tauri.memory.getGraph).toHaveBeenCalled());
  });
});
