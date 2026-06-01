import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentCard } from '../AgentCard';
import { tauri, type AgentConfig, type OpenClawTestMessageResult } from '@/lib/tauri';

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
      },
      openclaw: {
        ...actual.tauri.openclaw,
        testAgentMessage: vi.fn(),
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

  // ── OpenClaw test mode ─────────────────────────────────────────────────────

  async function openOpenClawPanel() {
    // Open the run panel first.
    await userEvent.click(screen.getByRole('button', { name: /test panel for/i }));
    // Switch the runtime selector to OpenClaw.
    await userEvent.click(screen.getByRole('button', { name: /openclaw \(test\)/i }));
  }

  it('shows a runtime selector inside the test panel and defaults to local', async () => {
    render(<AgentCard agent={agent} onDelete={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /test panel for/i }));
    // Two runtime buttons present.
    expect(screen.getByRole('button', { name: /local feral/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /openclaw \(test\)/i })).toBeInTheDocument();
    // The local run UI is shown by default.
    expect(screen.getByText(/local test — feral agent only/i)).toBeInTheDocument();
  });

  it('switching to OpenClaw reveals the test panel with a clear "test mode" banner', async () => {
    render(<AgentCard agent={agent} onDelete={vi.fn()} />);
    await openOpenClawPanel();
    expect(screen.getByText(/openclaw test mode/i)).toBeInTheDocument();
    expect(screen.getByText(/openclaw-backed routing is experimental/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /test with openclaw/i })).toBeInTheDocument();
  });

  it('sends a one-shot test request and shows the OK state with the response text', async () => {
    mockTestAgent.mockResolvedValue({
      kind: 'ok',
      response_text: 'Hello from OpenClaw!',
      error_message: null,
      endpoint_tried: 'http://localhost:18789/v1/chat/completions',
    } satisfies OpenClawTestMessageResult);

    render(<AgentCard agent={agent} onDelete={vi.fn()} />);
    await openOpenClawPanel();

    const promptBox = screen.getByPlaceholderText(/enter one prompt to test/i);
    await userEvent.type(promptBox, 'say hi');
    await userEvent.click(screen.getByRole('button', { name: /test with openclaw/i }));

    await waitFor(() => {
      expect(screen.getByText(/openclaw responded/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/hello from openclaw!/i)).toBeInTheDocument();
    expect(mockTestAgent).toHaveBeenCalledWith('test-id-1', 'say hi', null);
  });

  it('shows a timeout state when the backend reports kind=timeout', async () => {
    mockTestAgent.mockResolvedValue({
      kind: 'timeout',
      response_text: null,
      error_message: 'No response within 15s. The gateway may be starting up or the model is loading.',
      endpoint_tried: 'http://localhost:18789/v1/chat/completions',
    } satisfies OpenClawTestMessageResult);

    render(<AgentCard agent={agent} onDelete={vi.fn()} />);
    await openOpenClawPanel();
    await userEvent.type(screen.getByPlaceholderText(/enter one prompt to test/i), 'slow?');
    await userEvent.click(screen.getByRole('button', { name: /test with openclaw/i }));

    await waitFor(() => {
      expect(screen.getByText(/^timeout$/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/no response within 15s/i)).toBeInTheDocument();
  });

  it('shows an auth-required state when the gateway returns 401/403', async () => {
    mockTestAgent.mockResolvedValue({
      kind: 'unsupported',
      response_text: null,
      error_message: 'OpenClaw gateway requires authentication (HTTP 401). Set the OPENCLAW_GATEWAY_TOKEN environment variable.',
      endpoint_tried: 'http://localhost:18789/v1/chat/completions',
    } satisfies OpenClawTestMessageResult);

    render(<AgentCard agent={agent} onDelete={vi.fn()} />);
    await openOpenClawPanel();
    await userEvent.type(screen.getByPlaceholderText(/enter one prompt to test/i), 'hello');
    await userEvent.click(screen.getByRole('button', { name: /test with openclaw/i }));

    await waitFor(() => {
      expect(screen.getByText(/auth required/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/settings → openclaw → connection/i)).toBeInTheDocument();
  });

  it('shows a generic error state for kind=error', async () => {
    mockTestAgent.mockResolvedValue({
      kind: 'error',
      response_text: null,
      error_message: 'connection refused',
      endpoint_tried: 'http://localhost:18789/v1/chat/completions',
    } satisfies OpenClawTestMessageResult);

    render(<AgentCard agent={agent} onDelete={vi.fn()} />);
    await openOpenClawPanel();
    await userEvent.type(screen.getByPlaceholderText(/enter one prompt to test/i), 'hello');
    await userEvent.click(screen.getByRole('button', { name: /test with openclaw/i }));

    await waitFor(() => {
      expect(screen.getByText(/^error$/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/connection refused/i)).toBeInTheDocument();
  });

  it('shows an invoke error if tauri.openclaw.testAgentMessage rejects', async () => {
    mockTestAgent.mockRejectedValue(new Error('IPC channel closed'));

    render(<AgentCard agent={agent} onDelete={vi.fn()} />);
    await openOpenClawPanel();
    await userEvent.type(screen.getByPlaceholderText(/enter one prompt to test/i), 'hello');
    await userEvent.click(screen.getByRole('button', { name: /test with openclaw/i }));

    await waitFor(() => {
      expect(screen.getByText(/test failed/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/IPC channel closed/i)).toBeInTheDocument();
  });

  it('does NOT render the OpenClaw test UI when runtime is Local (local run stays the default path)', async () => {
    mockRun.mockResolvedValue(undefined);
    render(<AgentCard agent={agent} onDelete={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /test panel for/i }));
    // Default is local — the OpenClaw banner should not be visible.
    expect(screen.queryByText(/openclaw test mode/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run agent/i })).toBeInTheDocument();
  });
});

