import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { DoneStep } from '../DoneStep';
import { tauri, type OpenClawTestMessageResult } from '@/lib/tauri';

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return {
    ...actual,
    tauri: {
      ...actual.tauri,
      openclaw: {
        ...actual.tauri.openclaw,
        warmupAgent: vi.fn(),
      },
    },
  };
});

const mockWarmup = vi.mocked(tauri.openclaw.warmupAgent);

describe('DoneStep', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('shows spinner then OpenClaw ready badge when warmup succeeds', async () => {
    mockWarmup.mockResolvedValue({
      kind: 'ok',
      response_text: 'ready',
      error_message: null,
      endpoint_tried: 'http://localhost:18789/v1/chat/completions',
    } satisfies OpenClawTestMessageResult);

    render(<DoneStep agentName="My Agent" agentId="agent-abc" onViewAgents={vi.fn()} />);
    expect(screen.getByText(/connecting to openclaw/i)).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText(/openclaw ready/i)).toBeInTheDocument();
    });
    expect(mockWarmup).toHaveBeenCalledWith('agent-abc');
  });

  it('shows setup-needed badge when warmup fails (gateway down or auth error)', async () => {
    mockWarmup.mockResolvedValue({
      kind: 'error',
      response_text: null,
      error_message: 'connection refused',
      endpoint_tried: null,
    } satisfies OpenClawTestMessageResult);

    render(<DoneStep agentName="My Agent" agentId="agent-abc" onViewAgents={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/openclaw not connected/i)).toBeInTheDocument();
    });
  });

  it('shows setup-needed badge when warmup returns kind=timeout', async () => {
    mockWarmup.mockResolvedValue({
      kind: 'timeout',
      response_text: null,
      error_message: 'No response within 15s.',
      endpoint_tried: null,
    } satisfies OpenClawTestMessageResult);

    render(<DoneStep agentName="My Agent" agentId="agent-abc" onViewAgents={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/openclaw not connected/i)).toBeInTheDocument();
    });
  });

  it('works without agentId — no warmup fires, agent is shown as saved', async () => {
    render(<DoneStep agentName="My Agent" onViewAgents={vi.fn()} />);
    // Let any pending microtasks flush before asserting warmup was not called.
    await Promise.resolve();
    expect(mockWarmup).not.toHaveBeenCalled();
    expect(screen.getByText(/"my agent" is ready/i)).toBeInTheDocument();
  });

  it('shows model name when loadedModelName is provided', async () => {
    mockWarmup.mockResolvedValue({
      kind: 'ok',
      response_text: 'ready',
      error_message: null,
      endpoint_tried: null,
    } satisfies OpenClawTestMessageResult);

    render(
      <DoneStep
        agentName="My Agent"
        agentId="agent-abc"
        loadedModelName="mistral-7b-q4.gguf"
        onViewAgents={vi.fn()}
      />,
    );
    expect(screen.getByText(/mistral-7b-q4\.gguf/i)).toBeInTheDocument();
    expect(screen.queryByText(/next steps/i)).not.toBeInTheDocument();
  });

  it('shows load-model hint when no loadedModelName', async () => {
    mockWarmup.mockResolvedValue({
      kind: 'error',
      response_text: null,
      error_message: null,
      endpoint_tried: null,
    } satisfies OpenClawTestMessageResult);

    render(<DoneStep agentName="My Agent" agentId="agent-abc" onViewAgents={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/load a model/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/next steps/i)).not.toBeInTheDocument();
  });

  it('never renders a numbered list of next steps', async () => {
    mockWarmup.mockResolvedValue({
      kind: 'error',
      response_text: null,
      error_message: null,
      endpoint_tried: null,
    } satisfies OpenClawTestMessageResult);

    render(<DoneStep agentName="My Agent" agentId="agent-abc" onViewAgents={vi.fn()} />);
    await Promise.resolve();
    expect(document.querySelector('ol')).toBeNull();
    expect(document.querySelector('li')).toBeNull();
  });
});
