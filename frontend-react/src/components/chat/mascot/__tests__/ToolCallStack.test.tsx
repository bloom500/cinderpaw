import { describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ToolCallStack } from '../ToolCallStack';
import type { ToolCallEvent } from '@/stores/chat';

function makeToolEvent(
  overrides: Partial<Extract<ToolCallEvent, { kind: 'tool' }>>,
): Extract<ToolCallEvent, { kind: 'tool' }> {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    kind: 'tool',
    name: overrides.name ?? 'web_search',
    emoji: overrides.emoji ?? '🔍',
    mainArg: overrides.mainArg ?? 'x',
    status: overrides.status ?? 'running',
    startedAt: overrides.startedAt ?? Date.now(),
    endedAt: overrides.endedAt ?? null,
    ...overrides,
  };
}

describe('ToolCallStack', () => {
  test('renders nothing for an empty stream', () => {
    const { container } = render(<ToolCallStack events={[]} active={true} />);
    expect(container.firstChild).toBeNull();
  });

  test('renders one bubble per event', () => {
    const events = [
      makeToolEvent({ id: '1', name: 'web_search' }),
      makeToolEvent({ id: '2', name: 'read_url' }),
    ];
    render(<ToolCallStack events={events} active={true} />);
    expect(screen.getAllByRole('status')).toHaveLength(2);
    expect(screen.getByText(/web_search/)).toBeInTheDocument();
    expect(screen.getByText(/read_url/)).toBeInTheDocument();
  });

  test('renders a context event label verbatim', () => {
    const event: Extract<ToolCallEvent, { kind: 'context' }> = {
      id: 'c1',
      kind: 'context',
      label: 'Skills: foo, bar',
      startedAt: Date.now(),
      endedAt: Date.now(),
      status: 'done',
    };
    render(<ToolCallStack events={[event]} active={true} />);
    expect(screen.getByText('Skills: foo, bar')).toBeInTheDocument();
  });

  test('handles 10 events without crashing (defensive — store caps at 4)', () => {
    const events = Array.from({ length: 10 }, (_, i) =>
      makeToolEvent({ id: String(i), name: `tool_${i}` }),
    );
    render(<ToolCallStack events={events} active={true} />);
    // 10 tool bubbles + 10 status nodes? actually each bubble has role="status" so 10.
    expect(screen.getAllByRole('status').length).toBeGreaterThanOrEqual(10);
  });

  test('renders a cowork A2A bubble with its title and detail', () => {
    const event: Extract<ToolCallEvent, { kind: 'cowork' }> = {
      id: 'msg:m1',
      kind: 'cowork',
      title: 'Alice → Bob',
      detail: 'Fixed in commit abc123; tests pass.',
      status: 'done',
      startedAt: Date.now(),
      endedAt: Date.now(),
    };
    render(<ToolCallStack events={[event]} active={true} />);
    expect(screen.getByText(/Alice → Bob/)).toBeInTheDocument();
    // Detail is collapsed until clicked, but the bubble itself is visible.
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  test('pending approval renders Approve/Deny; terminal cowork bubble does not', () => {
    const pending: Extract<ToolCallEvent, { kind: 'cowork' }> = {
      id: 'approval:r1',
      kind: 'cowork',
      title: '🔐 Shipper: Run command: rm -rf dist/',
      detail: 'Run command: rm -rf dist/',
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      approval: {
        requestId: 'r1',
        approvalClass: 'delete',
        description: 'Run command: rm -rf dist/',
      },
    };
    const { unmount } = render(<ToolCallStack events={[pending]} active={true} />);
    expect(screen.getByRole('group', { name: /Approval request/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument();
    unmount();

    const resolved: Extract<ToolCallEvent, { kind: 'cowork' }> = {
      ...pending,
      id: 'approval:r2',
      status: 'error',
      endedAt: Date.now(),
      approval: undefined,
    };
    render(<ToolCallStack events={[resolved]} active={true} />);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
  });
});
