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
});
