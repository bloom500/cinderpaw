import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageChain, doneSentence, elapsedLabel, sideChips, stepDetail, stepTitle, thoughtHeadline } from '../MessageChain';
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
    // The header and the row both say it: one quiet sentence, no "Worked for".
    expect(screen.getAllByText('Searched the web')).toHaveLength(2);
    expect(screen.queryByText(/Worked for/)).not.toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getAllByText('Searched the web')).toHaveLength(1);

    fireEvent.click(screen.getByText('Searched the web'));
    expect(screen.getAllByText('Searched the web')).toHaveLength(2);
  });

  it('shows the reasoning live while the model thinks, headed by what it is thinking about', () => {
    render(<MessageChain thinking={'**Looking up fireflies**\n\nCaut ce mananca'} thinkingComplete={false} durationSec={undefined} steps={[]} streaming />);
    // In the header, and in the reasoning itself below it.
    expect(screen.getAllByText('Looking up fireflies')).toHaveLength(2);
    expect(screen.getByText('Thinking')).toBeInTheDocument();
    expect(screen.getByText('Caut ce mananca')).toBeInTheDocument();
  });

  it('heads a thought by its newest bold title, else its newest first sentence', () => {
    expect(thoughtHeadline('**Plan**\nx\n**Comparing prices:**\ny')).toBe('Comparing prices');
    expect(thoughtHeadline('Old idea.\n\nThe user wants three dinners. Then I will write.')).toBe('The user wants three dinners');
    expect(thoughtHeadline('')).toBeNull();
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

  // 27 Oct, his ask: no card and no pills. The rows still pop in while the agent
  // works; a chat opened again replays nothing.
  it('is a plain line, no card, and pops its rows in only while the agent works', () => {
    const search = startActivity('web_search', { query: 'Rome flights' });
    const live = render(<MessageChain thinking={null} thinkingComplete durationSec={undefined} steps={[search]} streaming />);
    expect(live.container.querySelector('[data-gooey-card]')).toBeNull();
    expect(screen.getByTestId('activity-line').className).not.toMatch(/rounded|border|bg-/);
    expect(live.container.querySelector('.row-pop')).toHaveTextContent('Searching the web');
    live.unmount();

    const done = finishActivity(search, { ok: true, content: '' });
    const old = render(<MessageChain thinking={null} thinkingComplete durationSec={undefined} steps={[done]} streaming={false} />);
    fireEvent.click(screen.getByText('Searched the web'));
    expect(screen.getAllByText('Searched the web')).toHaveLength(2);
    expect(old.container.querySelector('.row-pop')).toBeNull();
  });

  it('shows what the agent saw: newest pictures on the folded line, each step its own', () => {
    const png = (n: number) => `data:image/png;base64,${'A'.repeat(n)}`;
    const shot = finishActivity(startActivity('computer_use', { action: 'screenshot' }), {
      ok: true, content: 'took a screenshot', images: [png(1), png(2), 'https://evil.example/x.png'],
    });
    const read = finishActivity(startActivity('read_file', { path: 'a.png' }), { ok: true, content: '', images: [png(3), png(4)] });
    const { container } = render(<MessageChain thinking={null} thinkingComplete durationSec={undefined} steps={[shot, read]} streaming={false} />);
    // Folded: only the line, with the newest three pictures; the remote URL never loads.
    const line = container.querySelectorAll('img');
    expect([...line].map((i) => i.getAttribute('src'))).toEqual([png(2), png(3), png(4)]);
    fireEvent.click(screen.getByText(/^Used an app/));
    // Open: each step carries its own pictures, and the line drops its copy.
    const groups = screen.getAllByTestId('step-thumbs');
    expect(groups.map((g) => g.querySelectorAll('img').length)).toEqual([2, 2]);
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
    expect(stepDetail({ ...a, status: 'failed', error: 'timed out' })).toBe('Took too long');
    expect(stepDetail({ ...a, status: 'failed', error: 'Tool "read_file" short-circuited: circuit_open: too many failures' }))
      .toBe('Paused after failing a few times');
    expect(stepDetail({ ...a, status: 'failed', error: 'weird thing' })).toBe('Did not work');
  });

  it('sums up finished steps in one past-tense sentence, and says when one failed', () => {
    const ok = (tool: string) => finishActivity(startActivity(tool, {}), { ok: true });
    expect(doneSentence([ok('web_search'), ok('read_webpage'), ok('web_search')])).toBe('Searched the web, read a page');
    expect(doneSentence([ok('web_search'), { ...ok('read_file'), status: 'failed' }])).toBe('Searched the web, read files (one did not work)');
    expect(doneSentence(['web_search', 'read_file', 'shell_exec', 'recall'].map(ok))).toBe('Searched the web, read files, ran a command, and 1 more');
    expect(stepTitle(startActivity('ask_user', {}))).toBe('Waiting for your answer');
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
    // A helper still working is words on the line, next to the count: no chip.
    expect(screen.getByText('1 helper · 1 step')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Started helpers'));
    const rows = screen.getAllByTestId('strip-helper').map((r) => r.textContent);
    expect(rows).toEqual(['compare prices' + 'working · 1m 12s', 'api reviewer' + 'done · 40s']);
  });
});
