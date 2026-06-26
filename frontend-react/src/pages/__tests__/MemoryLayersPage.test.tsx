import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import MemoryLayersPage from '@/pages/MemoryLayersPage';
import { tauri } from '@/lib/tauri';
import { listen } from '@tauri-apps/api/event';
import type { TreeLayout } from '@/lib/tree/layout';

// Stub the Tauri event-bus so `listen()` never touches __TAURI_INTERNALS__ in jsdom.
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve()) }));

// Capture every layout handed to the renderer so we can assert the tree shape.
const renderedLayouts: TreeLayout[] = [];
vi.mock('@/lib/tree/render', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tree/render')>();
  return {
    ...actual,
    createTreeRenderer: vi.fn(() => ({
      render: (layout: TreeLayout) => { renderedLayouts.push(layout); },
      hitTestBranch: () => null,
      resize: vi.fn(),
      dispose: vi.fn(),
    })),
  };
});

beforeEach(() => {
  renderedLayouts.length = 0;
  localStorage.clear();
  vi.spyOn(tauri.memory, 'getGraph').mockResolvedValue({
    nodes: [{ id: 'a', label: 'Alpha', type: 'entity', touched_at: 1 }],
    edges: [],
  });
  vi.spyOn(tauri.rsi, 'status').mockResolvedValue({
    initialized: false, bounds_sha256: null, bounds_version: null,
    max_total_cost_usd: null, cost_warning_ratio: null,
    main_tip: null, main_tip_score: null, engine: null,
  });
});

describe('MemoryLayersPage (reactive tree)', () => {
  it('mounts and pulls the memory graph on load', async () => {
    render(<MemoryLayersPage />);
    await vi.waitFor(() => expect(tauri.memory.getGraph).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /refresh tree/i })).toBeInTheDocument();
  });

  it('a grow event re-lays out the tree with one branch per cluster', async () => {
    const handlers: ((e: any) => void)[] = [];
    (listen as any).mockImplementation((name: string, cb: (e: any) => void) => {
      if (name === 'feral://agent-output') handlers.push(cb);
      return Promise.resolve(() => {});
    });
    render(<MemoryLayersPage />);
    await vi.waitFor(() => expect(handlers.length).toBeGreaterThan(0));

    const grow = {
      type: 'fractal_activity', kind: 'grow', leafCount: 500, clusterCount: 4,
      clusters: [
        { x: 0, y: 0, weight: 1 },
        { x: 0, y: 0, weight: 0.6 },
        { x: 0, y: 0, weight: 0.4 },
        { x: 0, y: 0, weight: 0.2 },
      ],
    };
    for (const cb of handlers) cb({ payload: { data: JSON.stringify(grow) } });

    await vi.waitFor(() => {
      const last = renderedLayouts.at(-1);
      expect(last?.branches.length).toBe(4);
    });
  });
});
