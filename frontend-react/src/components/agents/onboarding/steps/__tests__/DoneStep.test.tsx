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
      feralAgent: {
        ...actual.tauri.feralAgent,
        status: vi.fn(),
      },
    },
  };
});

const mockStatus = vi.mocked(tauri.feralAgent.status);

beforeEach(() => vi.clearAllMocks());

describe('DoneStep', () => {
  it('shows not-running message when Feral Agent sidecar status is false', async () => {
    mockStatus.mockResolvedValue(false);

    render(
      <DoneStep
        agentName="Test"
        agentId="agent-1"
        onViewAgents={vi.fn()}
      />
    );

    await waitFor(() => expect(mockStatus).toHaveBeenCalled());
    expect(screen.getByText(/not running/i)).toBeTruthy();
  });

  it('shows ready state when Feral Agent sidecar is up', async () => {
    mockStatus.mockResolvedValue(true);

    render(
      <DoneStep
        agentName="Test"
        agentId="agent-1"
        onViewAgents={vi.fn()}
      />
    );

    await waitFor(() => expect(mockStatus).toHaveBeenCalled());
    expect(screen.getByText(/feral agent ready/i)).toBeTruthy();
  });
});
