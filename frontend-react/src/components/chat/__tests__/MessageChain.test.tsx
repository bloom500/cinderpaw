import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageChain, elapsedLabel, sideChips, stepDetail, stepTitle, workedSeconds } from '../MessageChain';
import type { RlmWorker } from '@/stores/rlmWorkers';
import { finishActivity, startActivity } from '@/hooks/useLiveToolActivity';

vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));
// The sprite is a canvas, which jsdom cannot draw.
vi.mock('../mascot/CinderpawMascot', () => ({ CinderpawMascot: () => <span data-testid="mascot" /> }));

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('MessageChain (the Activity Strip)', () => {
  it('says what it is doing live, then folds a beat after the whole answer, and reopens on click', () => {
    const search = startActivity('web_search', { query: 'licurici' });
    const props = { thinking: 'Caut ce mananca licuricii', thinkingComplete: true, durationSec: undefined };
    const { rerender } = render(<MessageChain {...props} steps={[search]} streaming />);

    expect(screen.getAllByText('Searching the web').length).toBeGreaterThan(0);
    expect(screen.getByText('1 step · 0s')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(12_000); });
    expect(screen.getByText('1 step · 12s')).toBeInTheDocument();

    const done = finishActivity(search, { ok: true, content: '' });
    rerender(<MessageChain {...props} durationSec={5} steps={[done]} streaming={false} />);
    // Still open while the finished answer lands: folding at once is the old bug.
    expect(screen.getByText('Searched the web')).toBeInTheDocument();
    expect(screen.getByText('Worked for 12 seconds')).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.queryByText('Searched the web')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Worked for 12 seconds'));
    expect(screen.getByText('Searched the web')).toBeInTheDocument();
  });

  it('shows the reasoning live while the model thinks', () => {
    render(<MessageChain thinking="Caut" thinkingComplete={false} durationSec={undefined} steps={[]} streaming />);
    expect(screen.getAllByText('Thinking').length).toBe(2);
    expect(screen.getByText('Caut')).toBeInTheDocument();
  });

  it('a reopened chat starts folded and does not fold or open by itself', () => {
    render(<MessageChain thinking="old" thinkingComplete durationSec={undefined} steps={[]} streaming={false} />);
    expect(screen.getByText('Reasoning')).toBeInTheDocument();
    expect(screen.queryByText('old')).not.toBeInTheDocument();
  });

  it('a group of tools in the timeline is named by what runs, not "Thinking"', () => {
    const steps = [startActivity('web_search', { query: 'x' }), startActivity('read_file', { path: 'a' })];
    render(<MessageChain thinking={null} thinkingComplete durationSec={undefined} steps={steps} streaming />);
    expect(screen.queryByText('Thinking')).not.toBeInTheDocument();
    expect(screen.getByText('2 steps · 0s')).toBeInTheDocument();
  });

  it('draws nothing when there was no reasoning and no tool', () => {
    const { container } = render(<MessageChain thinking={null} thinkingComplete durationSec={undefined} steps={[]} streaming />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('step words', () => {
  it('present while running, past once done', () => {
    const a = startActivity('web_search', { query: 'x' });
    expect(stepTitle(a)).toBe('Searching the web');
    expect(stepTitle(finishActivity(a, { ok: true }))).toBe('Searched the web');
    expect(stepTitle(startActivity('some_new_tool', {}))).toBe('Some new tool');
  });

  it('counts what a step found, or says what it was about', () => {
    const a = startActivity('web_search', { query: 'e-bikes' });
    expect(stepDetail({ ...a, hits: [{}, {}, {}] as never })).toBe('3 sources');
    expect(stepDetail({ ...a, hits: [{}] as never })).toBe('1 source');
    expect(stepDetail(a)).toBe('e-bikes');
    expect(stepDetail({ ...a, status: 'failed', error: 'timed out' })).toBe('timed out');
  });

  it('times the steps first start to last end, and says nothing it did not measure', () => {
    const a = { ...startActivity('x', {}), startedAt: 1_000, endedAt: 4_000 };
    const b = { ...startActivity('y', {}), startedAt: 2_000, endedAt: 43_000 };
    expect(workedSeconds([a, b])).toBe(42);
    expect(workedSeconds([a, { ...b, endedAt: null }])).toBeNull();
    expect(elapsedLabel(72_000)).toBe('1m 12s');
  });
});

const helper = (over: Partial<RlmWorker>): RlmWorker => ({
  childId: 'w1', sessionId: 's', name: 'subagent-compare-prices-a1b2', status: 'running',
  detail: null, answer: null, startedAt: 0, endedAt: null, ...over,
});

describe('side activities and helpers', () => {
  it('chips name a memory lookup, an artifact in progress, and helpers still working', () => {
    const memory = startActivity('recall', { query: 'x' });
    const artifact = startActivity('artifact_create', { title: 'Plan' });
    expect(sideChips([memory, artifact], [helper({}), helper({ childId: 'w2' }), helper({ childId: 'w3', status: 'completed' })]))
      .toEqual(['Using memory', 'Generating artifact', '2 helpers']);
    expect(sideChips([finishActivity(memory, { ok: true })], [])).toEqual([]);
  });

  it("lists the chat's helpers with their state and time, after the reply has finished", () => {
    vi.setSystemTime(72_000);
    const done = finishActivity({ ...startActivity('rlm', {}), startedAt: 0 }, { ok: true });
    render(
      <MessageChain thinking={null} thinkingComplete durationSec={undefined} steps={[done]} streaming={false}
        helpers={[helper({}), helper({ childId: 'w2', name: 'api-reviewer', status: 'completed', endedAt: 40_000 })]} />,
    );
    expect(screen.getByText('1 helper')).toBeInTheDocument();
    fireEvent.click(screen.getByText(/^Worked for/));
    const rows = screen.getAllByTestId('strip-helper').map((r) => r.textContent);
    expect(rows).toEqual(['compare prices' + 'working · 1m 12s', 'api reviewer' + 'done · 40s']);
  });
});
