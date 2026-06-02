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
      openclaw: {
        ...actual.tauri.openclaw,
        detect: vi.fn(),
        warmupAgent: vi.fn(),
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

  it('opens the run panel and shows Run button (no OpenClaw test UI)', async () => {
    mockRun.mockResolvedValue(undefined);
    render(<AgentCard agent={agent} onDelete={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /test panel for/i }));
    // Streaming run button is present.
    expect(screen.getByRole('button', { name: /run agent/i })).toBeInTheDocument();
    // No OpenClaw test mode banner.
    expect(screen.queryByText(/openclaw test mode/i)).not.toBeInTheDocument();
  });

  describe('runtime badge', () => {
    it('shows "OpenClaw ready" badge when gatewayUp=true and openclaw_ready=true', () => {
      const readyAgent: AgentConfig = { ...agent, openclaw_ready: true };
      render(<AgentCard agent={readyAgent} gatewayUp={true} onDelete={vi.fn()} />);
      expect(screen.getByText(/openclaw ready/i)).toBeInTheDocument();
    });

    it('shows "Setup needed" badge when gatewayUp=true and openclaw_ready=null', () => {
      render(<AgentCard agent={agent} gatewayUp={true} onDelete={vi.fn()} />);
      expect(screen.getByText(/setup needed/i)).toBeInTheDocument();
    });

    it('shows "Setup needed" badge when gatewayUp=true and openclaw_ready=false', () => {
      const failedAgent: AgentConfig = { ...agent, openclaw_ready: false };
      render(<AgentCard agent={failedAgent} gatewayUp={true} onDelete={vi.fn()} />);
      expect(screen.getByText(/setup needed/i)).toBeInTheDocument();
    });

    it('shows "Gateway unavailable" badge when gatewayUp=false regardless of openclaw_ready', () => {
      const readyAgent: AgentConfig = { ...agent, openclaw_ready: true };
      render(<AgentCard agent={readyAgent} gatewayUp={false} onDelete={vi.fn()} />);
      expect(screen.getByText(/gateway unavailable/i)).toBeInTheDocument();
    });

    it('shows no badge when gatewayUp is null/undefined (still loading)', () => {
      render(<AgentCard agent={agent} gatewayUp={null} onDelete={vi.fn()} />);
      expect(screen.queryByText(/openclaw ready/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/setup needed/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/gateway unavailable/i)).not.toBeInTheDocument();
    });
  });
});

describe('AgentCard runtime selector', () => {
  it('does not render a Local / OpenClaw toggle', () => {
    render(
      <AgentCard
        agent={agent}
        gatewayUp={true}
        onDelete={vi.fn()}
      />
    );
    expect(screen.queryByText(/local feral/i)).toBeNull();
    expect(screen.queryByText(/openclaw test mode/i)).toBeNull();
  });
});

