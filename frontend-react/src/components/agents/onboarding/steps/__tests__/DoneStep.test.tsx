import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { DoneStep } from '../DoneStep';
import { tauri } from '@/lib/tauri';

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

beforeEach(() => vi.clearAllMocks());

describe('DoneStep', () => {
  it('shows model-load prompt when warmup fails', async () => {
    mockWarmup.mockResolvedValue({
      kind: 'error',
      response_text: null,
      error_message: 'gateway unreachable',
      endpoint_tried: null,
    });

    render(
      <DoneStep
        agentName="Test"
        agentId="agent-1"
        onViewAgents={vi.fn()}
      />
    );

    await waitFor(() => expect(mockWarmup).toHaveBeenCalled());

    // Must NOT mention OpenClaw to the user
    expect(screen.queryByText(/openclaw/i)).toBeNull();
    // Must tell user to load a model
    expect(screen.getByText(/load a model/i)).toBeTruthy();
  });

  it('shows ready state when warmup succeeds', async () => {
    mockWarmup.mockResolvedValue({
      kind: 'ok',
      response_text: 'ready',
      error_message: null,
      endpoint_tried: null,
    });

    render(
      <DoneStep
        agentName="Test"
        agentId="agent-1"
        onViewAgents={vi.fn()}
      />
    );

    await waitFor(() => expect(mockWarmup).toHaveBeenCalled());
    expect(screen.getByText(/ready/i)).toBeTruthy();
  });
});
