import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentCard } from '../AgentCard';
import { tauri, type AgentConfig } from '@/lib/tauri';

const agent: AgentConfig = {
  id: 'test-id-1',
  name: 'Test Agent',
  system_prompt: 'You are helpful.',
  model_id: '',
  tools: [],
};

// Mock the tauri façade so tests can be exercised without hitting the real
// backend. `tauri.agents.run` is stubbed per-test.
vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return {
    ...actual,
    tauri: {
      ...actual.tauri,
      agents: {
        ...actual.tauri.agents,
        run: vi.fn(),
        getAll: vi.fn(),
      },
    },
  };
});

const mockRun = vi.mocked(tauri.agents.run);

describe('AgentCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps dialog open and shows error when delete prop rejects', async () => {
    const onDelete = vi.fn().mockRejectedValue(new Error('disk is full'));
    render(<AgentCard agent={agent} onDelete={onDelete} />);

    await userEvent.click(screen.getByRole('button', { name: /delete test agent/i }));
    expect(screen.getByText(/delete "test agent"/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    await waitFor(() => {
      expect(screen.getByText(/disk is full/i)).toBeInTheDocument();
    });
    // Dialog must still be open
    expect(screen.getByText(/delete "test agent"/i)).toBeInTheDocument();
  });

  it('closes dialog on successful delete', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(<AgentCard agent={agent} onDelete={onDelete} />);

    await userEvent.click(screen.getByRole('button', { name: /delete test agent/i }));
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    await waitFor(() => {
      expect(screen.queryByText(/delete "test agent"/i)).not.toBeInTheDocument();
    });
  });

  it('opens the run panel and shows Run button', async () => {
    mockRun.mockResolvedValue(undefined);
    render(<AgentCard agent={agent} onDelete={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /test panel for/i }));
    expect(screen.getByRole('button', { name: /run agent/i })).toBeInTheDocument();
  });

  describe('Feral Agent status badge', () => {
    it('shows "Feral Agent ready" badge when agentUp=true', () => {
      render(<AgentCard agent={agent} agentUp={true} onDelete={vi.fn()} />);
      expect(screen.getByText(/feral agent ready/i)).toBeInTheDocument();
    });

    it('shows "Feral Agent unavailable" badge when agentUp=false', () => {
      render(<AgentCard agent={agent} agentUp={false} onDelete={vi.fn()} />);
      expect(screen.getByText(/feral agent unavailable/i)).toBeInTheDocument();
    });

    it('shows no badge when agentUp is null/undefined (still loading)', () => {
      render(<AgentCard agent={agent} agentUp={null} onDelete={vi.fn()} />);
      expect(screen.queryByText(/feral agent ready/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/feral agent unavailable/i)).not.toBeInTheDocument();
    });
  });
});
