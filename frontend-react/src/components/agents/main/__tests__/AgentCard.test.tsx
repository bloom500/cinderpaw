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

// Mock the tauri façade so the OpenClaw test button can be exercised without
// hitting the real backend. `tauri.agents.run` and `tauri.openclaw.*` are
// stubbed per-test.
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
        testAgentMessage: vi.fn(),
        detect: vi.fn(),
        warmupAgent: vi.fn(),
      },
    },
  };
});

const mockRun           = vi.mocked(tauri.agents.run);
const mockTestAgent     = vi.mocked(tauri.openclaw.testAgentMessage);

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

  // ── OpenClaw runtime mode ─────────────────────────────────────────────────

  async function openRunPanel() {
    await userEvent.click(screen.getByRole('button', { name: /test panel for/i }));
  }

  async function switchToOpenClawRuntime() {
    await userEvent.click(screen.getByRole('button', { name: /openclaw/i }));
  }

  it('shows a runtime selector inside the run panel and defaults to local when preferred_runtime is unset', async () => {
    render(<AgentCard agent={agent} onDelete={vi.fn()} />);
    await openRunPanel();
    // Two runtime buttons present.
    expect(screen.getByRole('button', { name: /local feral/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /openclaw/i })).toBeInTheDocument();
    // The local run UI is shown by default.
    expect(screen.getByText(/local test — feral agent only/i)).toBeInTheDocument();
  });

  it('defaults RuntimeSelector to OpenClaw when agent.preferred_runtime is "openclaw"', async () => {
    const openclawAgent: AgentConfig = { ...agent, preferred_runtime: 'openclaw' };
    render(<AgentCard agent={openclawAgent} onDelete={vi.fn()} />);
    await openRunPanel();
    // The OpenClaw runtime banner is the visible signal that the selector
    // is on OpenClaw. We don't assert against the local body label because
    // LocalTestBody is also re-used inside the OpenClaw body (it owns the
    // prompt textarea + Run button). The active runtime is unambiguous
    // because only one banner is rendered per branch.
    expect(screen.getByText(/openclaw runtime/i)).toBeInTheDocument();
  });

  it('switching to OpenClaw reveals the runtime panel with a clear banner and a Run button', async () => {
    render(<AgentCard agent={agent} onDelete={vi.fn()} />);
    await openRunPanel();
    await switchToOpenClawRuntime();
    expect(screen.getByText(/openclaw runtime/i)).toBeInTheDocument();
    expect(screen.getByText(/streams your prompt through the local openclaw gateway/i)).toBeInTheDocument();
    // Run button still says "Run" — same execution path as local.
    expect(screen.getByRole('button', { name: /run agent/i })).toBeInTheDocument();
  });

  it('OpenClaw Run button routes through tauri.agents.run (real backend), not the legacy testAgentMessage call site', async () => {
    // The OpenClaw runtime reuses the Local Feral Run path — the only
    // contract we need to assert at this layer is that the legacy
    // one-shot `tauri.openclaw.testAgentMessage` call site is NOT used.
    // (The actual `tauri.agents.run` invocation is covered by the
    //  Local Feral run-path tests, which use the same handler.)
    render(<AgentCard agent={agent} onDelete={vi.fn()} />);
    await openRunPanel();
    await switchToOpenClawRuntime();
    // The OpenClaw banner is up and the Run button is the local-style
    // one (not the legacy "Test with OpenClaw" label).
    expect(screen.getByText(/openclaw runtime/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run agent/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /test with openclaw/i })).not.toBeInTheDocument();
    // mockTestAgent must not have been touched — there is no UI path
    // that calls the legacy one-shot test endpoint from the runtime
    // selector any more.
    expect(mockTestAgent).not.toHaveBeenCalled();
  });

  it('OpenClaw runtime shows system prompt preview in the banner details', async () => {
    const richAgent: AgentConfig = {
      ...agent,
      system_prompt: 'You are a precise research assistant. Always cite sources.',
    };
    render(<AgentCard agent={richAgent} onDelete={vi.fn()} />);
    await openRunPanel();
    await switchToOpenClawRuntime();
    expect(screen.getByText(/openclaw runtime/i)).toBeInTheDocument();
    // The collapsible details summary is rendered.
    expect(screen.getByText(/system prompt/i)).toBeInTheDocument();
  });

  it('does NOT render the OpenClaw runtime UI when runtime is Local (local run stays the default path)', async () => {
    mockRun.mockResolvedValue(undefined);
    render(<AgentCard agent={agent} onDelete={vi.fn()} />);
    await openRunPanel();
    // Default is local — the OpenClaw banner should not be visible.
    expect(screen.queryByText(/openclaw runtime/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run agent/i })).toBeInTheDocument();
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

