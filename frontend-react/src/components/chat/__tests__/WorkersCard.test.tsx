import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkersCard } from '../WorkersCard';
import { useRlmWorkers } from '@/stores/rlmWorkers';
import { useChat } from '@/stores/chat';

vi.mock('@/lib/clipboard', () => ({ copyText: vi.fn().mockResolvedValue(true) }));

describe('WorkersCard', () => {
  beforeEach(() => {
    useRlmWorkers.setState({ workers: [] });
    useChat.setState({ sessionId: 's1' });
  });

  test('renders nothing in a chat with no workers', () => {
    const { container } = render(<WorkersCard />);
    expect(container).toBeEmptyDOMElement();
  });

  test('shows a running worker with what it is doing', () => {
    useRlmWorkers.getState().upsert({
      sessionId: 's1', childId: 'sa-1', name: 'subagent-count-the-files-a1b2',
      status: 'running', detail: 'tool_start grep',
    });
    render(<WorkersCard />);
    expect(screen.getByText('count the files')).toBeInTheDocument();
    expect(screen.getByText('tool_start grep')).toBeInTheDocument();
    expect(screen.getByText('1 working')).toBeInTheDocument();
  });

  test('ignores workers of another chat', () => {
    useRlmWorkers.getState().upsert({ sessionId: 's2', childId: 'sa-9', name: 'elsewhere', status: 'running' });
    const { container } = render(<WorkersCard />);
    expect(container).toBeEmptyDOMElement();
  });

  test("opens a finished worker's answer, the part the reply may never show", async () => {
    useRlmWorkers.getState().upsert({
      sessionId: 's1', childId: 'sa-1', name: 'api-reviewer', status: 'completed',
      detail: '3 tool call(s)', answer: 'Two endpoints lack auth.',
    });
    render(<WorkersCard />);
    expect(screen.queryByText('Two endpoints lack auth.')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /answer/i }));
    expect(screen.getByText('Two endpoints lack auth.')).toBeInTheDocument();
  });

  test('shows why a worker failed', () => {
    useRlmWorkers.getState().upsert({
      sessionId: 's1', childId: 'sa-1', name: 'api-reviewer', status: 'error', detail: 'budget_exceeded',
    });
    render(<WorkersCard />);
    expect(screen.getByText('budget_exceeded')).toBeInTheDocument();
  });

  test('dismissing a finished worker removes it', async () => {
    useRlmWorkers.getState().upsert({ sessionId: 's1', childId: 'sa-1', name: 'api-reviewer', status: 'completed' });
    render(<WorkersCard />);
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss api reviewer' }));
    expect(useRlmWorkers.getState().workers).toEqual([]);
  });
});
