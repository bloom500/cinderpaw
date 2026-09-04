import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DoneStep } from '../DoneStep';
import { tauri } from '@/lib/tauri';

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return {
    ...actual,
    tauri: {
      ...actual.tauri,
      cinderpawAgent: {
        ...actual.tauri.cinderpawAgent,
        status: vi.fn(),
      },
    },
  };
});

const mockStatus = vi.mocked(tauri.cinderpawAgent.status);

beforeEach(() => vi.clearAllMocks());

describe('DoneStep', () => {
  it('shows not-running message when Cinderpaw Agent sidecar status is false', async () => {
    mockStatus.mockResolvedValue(false);

    render(
      <DoneStep
        agentName="Test"
        agentId="agent-1"
        onStartChatting={vi.fn()}
      />
    );

    await waitFor(() => expect(mockStatus).toHaveBeenCalled());
    expect(screen.getByText(/not running/i)).toBeTruthy();
  });

  it('shows ready state when Cinderpaw Agent sidecar is up', async () => {
    mockStatus.mockResolvedValue(true);

    render(
      <DoneStep
        agentName="Test"
        agentId="agent-1"
        onStartChatting={vi.fn()}
      />
    );

    await waitFor(() => expect(mockStatus).toHaveBeenCalled());
    expect(screen.getByText(/cinderpaw agent ready/i)).toBeTruthy();
  });

  it('invokes onStartChatting when the "Start chatting" button is clicked', async () => {
    mockStatus.mockResolvedValue(true);
    const onStartChatting = vi.fn();

    render(
      <DoneStep
        agentName="Test"
        agentId="agent-1"
        onStartChatting={onStartChatting}
      />
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /start chatting/i }));

    expect(onStartChatting).toHaveBeenCalledTimes(1);
  });
});
