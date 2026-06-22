import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import MemoryLayersPage from '@/pages/MemoryLayersPage';
import { tauri } from '@/lib/tauri';
import { deriveOrganismState } from '@/lib/fractal/signal';
import { listen } from '@tauri-apps/api/event';

// Stub out the Tauri event-bus so `listen()` never touches window.__TAURI_INTERNALS__
// in jsdom. Returns a no-op unlisten promise, matching the real UnlistenFn shape.
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

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

  it('a grow event derives from the event payload, not the node-type proxy', async () => {
    // Capture the fractal-activity callback the page registers.
    const handlers: ((e: any) => void)[] = [];
    (listen as any).mockImplementation((name: string, cb: (e: any) => void) => {
      if (name === 'feral://agent-output') handlers.push(cb);
      return Promise.resolve(() => {});
    });
    render(<MemoryLayersPage />);
    await vi.waitFor(() => expect(handlers.length).toBeGreaterThan(0));
    (deriveOrganismState as any).mockClear();
    // Emit a grow line with real cluster data.
    const grow = { type: 'fractal_activity', kind: 'grow', leafCount: 500, clusterCount: 64,
                   clusters: [{ x: -0.5, y: 0.1, weight: 1 }] };
    for (const cb of handlers) cb({ payload: JSON.stringify(grow) });
    await vi.waitFor(() => expect(deriveOrganismState).toHaveBeenCalled());
    const arg = (deriveOrganismState as any).mock.calls.at(-1)[0];
    expect(arg.clusterCount).toBe(64);
    expect(arg.eliteNodeCount).toBe(500);
    expect(arg.clusters).toEqual([{ x: -0.5, y: 0.1, weight: 1 }]);
  });
});
