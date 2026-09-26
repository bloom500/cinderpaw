import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CoworkApprovalDock } from '../CoworkApprovalDock';
import { useCoworkTranscript, type CoworkExchange } from '@/stores/coworkTranscript';
import { useChat } from '@/stores/chat';

function approval(over: Partial<CoworkExchange> = {}): CoworkExchange {
  return {
    id: 'approval:r1',
    threadId: 'chat-a',
    kind: 'approval',
    fromAgentId: 'shipper',
    fromName: 'Shipper',
    toAgentId: 'human',
    requestText: 'Run command: rm -rf dist/',
    responseText: null,
    status: 'running',
    at: 0,
    ...over,
  };
}

const at = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <CoworkApprovalDock />
    </MemoryRouter>,
  );

describe('CoworkApprovalDock', () => {
  beforeEach(() => useCoworkTranscript.setState({ exchanges: [], activeThreadId: null }));
  afterEach(() => vi.restoreAllMocks());

  test('shows a pending request from any screen, with what it is for', () => {
    useCoworkTranscript.setState({ exchanges: [approval()] });
    at('/settings');
    expect(screen.getByText('Shipper needs your approval')).toBeInTheDocument();
    expect(screen.getByText('Run command: rm -rf dist/')).toBeInTheDocument();
  });

  test("leaves the open chat's own request to that chat's panel", () => {
    useCoworkTranscript.setState({ exchanges: [approval()], activeThreadId: 'chat-a' });
    at('/chat/chat-a');
    expect(screen.queryByTestId('cowork-approval-dock')).not.toBeInTheDocument();
  });

  test('shows a request from another chat while one chat is open', () => {
    useCoworkTranscript.setState({ exchanges: [approval()], activeThreadId: 'chat-b' });
    at('/chat/chat-b');
    expect(screen.getByTestId('cowork-approval-dock')).toBeInTheDocument();
  });

  test('ignores requests that are already answered', () => {
    useCoworkTranscript.setState({ exchanges: [approval({ status: 'done' })] });
    at('/settings');
    expect(screen.queryByTestId('cowork-approval-dock')).not.toBeInTheDocument();
  });

  test('Approve sends the verdict for that request', async () => {
    const resolve = vi.spyOn(useChat.getState(), 'resolveCoworkApproval').mockResolvedValue(undefined);
    useCoworkTranscript.setState({ exchanges: [approval()] });
    at('/settings');
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(resolve).toHaveBeenCalledWith('r1', true);
  });

  test('a verdict that did not arrive gives the buttons back and says why', async () => {
    vi.spyOn(useChat.getState(), 'resolveCoworkApproval').mockRejectedValue(new Error('engine offline'));
    useCoworkTranscript.setState({ exchanges: [approval()] });
    at('/settings');
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(await screen.findByText('Not sent: engine offline')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument();
  });
});
