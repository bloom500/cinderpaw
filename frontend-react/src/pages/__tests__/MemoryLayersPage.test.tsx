import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import MemoryLayersPage from '@/pages/MemoryLayersPage';
import { tauri } from '@/lib/tauri';

vi.mock('@/lib/fractal/organism', () => ({
  createOrganismRenderer: vi.fn(() => ({
    render: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
  })),
  DEFAULT_VIEW: { scale: 1, centerX: 0, centerY: 0 },
}));

vi.mock('@/lib/fractal/signal', () => ({
  deriveOrganismState: vi.fn(() => ({
    state: { power: 2, depthBoost: 0, morph: 0, warpSeeds: [] },
    floor: 1,
  })),
}));

vi.mock('@/lib/fractal/maturity', () => ({
  maturity: {
    current: vi.fn(() => 0),
    bump: vi.fn(),
  },
}));

beforeEach(() => {
  vi.spyOn(tauri.memory, 'getGraph').mockResolvedValue({
    nodes: [{ id: 'a', label: 'Alpha', type: 'entity', touched_at: 1 }],
    edges: [],
  });
  vi.spyOn(tauri.rsi, 'status').mockResolvedValue({
    initialized: false,
    bounds_sha256: null,
    bounds_version: null,
    max_total_cost_usd: null,
    cost_warning_ratio: null,
    main_tip: null,
    main_tip_score: null,
    engine: null,
  });
});

describe('MemoryLayersPage', () => {
  it('mounts and calls getGraph on load', async () => {
    render(<MemoryLayersPage />);
    await vi.waitFor(() => expect(tauri.memory.getGraph).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /refresh organism/i })).toBeInTheDocument();
  });
});
