import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageChain } from '../MessageChain';
import { finishActivity, startActivity } from '@/hooks/useLiveToolActivity';

vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('MessageChain', () => {
  it('shows the steps live, then folds a beat after the whole answer, and reopens on click', () => {
    const search = startActivity('web_search', { query: 'licurici' });
    const props = { thinking: 'Caut ce mananca licuricii', thinkingComplete: false, durationSec: undefined };
    const { rerender } = render(<MessageChain {...props} steps={[search]} streaming />);

    expect(screen.getByText('web search')).toBeInTheDocument();
    expect(screen.getByText('Thinking')).toBeInTheDocument();
    expect(screen.getByText('Caut ce mananca licuricii')).toBeInTheDocument();

    const done = finishActivity(search, { ok: true, content: '' });
    rerender(<MessageChain {...props} thinkingComplete durationSec={5} steps={[done]} streaming={false} />);
    // Still open while the finished answer lands: folding at once is the old bug.
    expect(screen.getByText('web search')).toBeInTheDocument();
    expect(screen.getByText('Thought for 5 seconds · 1 step')).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.queryByText('web search')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Thought for 5 seconds · 1 step'));
    expect(screen.getByText('web search')).toBeInTheDocument();
  });

  it('a reopened chat starts folded and does not fold or open by itself', () => {
    render(<MessageChain thinking="old" thinkingComplete durationSec={undefined} steps={[]} streaming={false} />);
    expect(screen.getByText('Reasoning')).toBeInTheDocument();
    expect(screen.queryByText('old')).not.toBeInTheDocument();
  });

  it('draws nothing when there was no reasoning and no tool', () => {
    const { container } = render(<MessageChain thinking={null} thinkingComplete durationSec={undefined} steps={[]} streaming />);
    expect(container).toBeEmptyDOMElement();
  });
});
