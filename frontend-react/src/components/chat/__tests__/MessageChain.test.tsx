import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageChain, doneSentence, elapsedLabel, firstLooks, sideChips, stepDetail, stepTitle, thoughtHeadline } from '../MessageChain';
import type { RlmWorker } from '@/stores/rlmWorkers';
import { finishActivity, startActivity } from '@/hooks/useLiveToolActivity';

vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));
// The sprite is a canvas, which jsdom cannot draw.
vi.mock('../mascot/CinderpawMascot', () => ({ CinderpawMascot: () => <span data-testid="mascot" /> }));

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('MessageChain (the Activity Strip)', () => {
  it('stays one line while it works, the words shimmering with what happens now, and opens on click', () => {
    const search = startActivity('web_search', { query: 'licurici' });
    const props = { thinking: 'Caut ce mananca licuricii', thinkingComplete: true, durationSec: undefined };
    const { rerender } = render(<MessageChain {...props} steps={[search]} streaming />);

    // Folded while working, like Claude's line: only the line says it, with a light passing over.
    expect(screen.getAllByText('Searching the web')).toHaveLength(1);
    expect(screen.getByText('Searching the web')).toHaveClass('shimmering-text');
    expect(screen.getByText('1 step · 0s')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(12_000); });
    expect(screen.getByText('1 step · 12s')).toBeInTheDocument();

    const done = finishActivity(search, { ok: true, content: '' });
    rerender(<MessageChain {...props} durationSec={5} steps={[done]} streaming={false} />);
    // One quiet sentence, no shimmer, no "Worked for", and nothing opens by itself.
    expect(screen.getByText('Searched the web')).not.toHaveClass('shimmering-text');
    expect(screen.queryByText(/Worked for/)).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getAllByText('Searched the web')).toHaveLength(1);

    fireEvent.click(screen.getByText('Searched the web'));
    expect(screen.getAllByText('Searched the web')).toHaveLength(2);
  });

  it('heads the line with what the model is thinking about; the reasoning is one click away', () => {
    render(<MessageChain thinking={'**Looking up fireflies**\n\nCaut ce mananca'} thinkingComplete={false} durationSec={undefined} steps={[]} streaming />);
    expect(screen.getAllByText('Looking up fireflies')).toHaveLength(1);
    expect(screen.queryByText('Caut ce mananca')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Looking up fireflies'));
    // Open: the reasoning itself, live, under the line.
    expect(screen.getByText('Thinking')).toBeInTheDocument();
    expect(screen.getByText('Caut ce mananca')).toBeInTheDocument();
  });

  it('keeps the widgets in view when folded, as tiles of the real widget, newest three', () => {
    const done = (tool: string, args: Record<string, unknown>, id: string, content = '') =>
      ({ ...finishActivity(startActivity(tool, args), { ok: true, content }), id });
    const steps = [
      done('shell_exec', { command: 'npm ci' }, 'c0', 'added 12 packages'),
      done('web_search', { query: 'lalele' }, 'w1'),
      done('shell_exec', { command: 'npm test' }, 'c1', '12 passed'),
      done('read_file', { path: 'a.md' }, 'f1'),
      done('some_tool', {}, 'g1'), // a generic step has no picture of its work
    ];
    render(<MessageChain thinking={null} thinkingComplete durationSec={undefined} steps={steps} streaming={false} />);
    const tiles = screen.getByTestId('mini-widgets');
    expect(tiles.querySelectorAll('button')).toHaveLength(3);
    expect(tiles).toHaveTextContent('+1');
    expect(tiles).toHaveTextContent('12 passed');
    // A tile shows only its own widget full size, the steps stay folded; a
    // second click puts it away.
    const tile = tiles.querySelector('button')!;
    fireEvent.click(tile);
    expect(screen.getByTestId('mini-widget-full')).toBeInTheDocument();
    expect(screen.getByTestId('mini-widgets')).toBeInTheDocument();
    expect(tile).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(tile);
    expect(screen.queryByTestId('mini-widget-full')).toBeNull();
  });

  it('counts a step done more than once, like "captured page 5 times"', () => {
    const shot = (n: number) => ({ ...finishActivity(startActivity('browser', { action: 'screenshot' }), { ok: true, content: '', images: ['data:image/png;base64,AA'] }), id: `b${n}` });
    expect(doneSentence([shot(1), shot(2), shot(3)])).toBe('Took a picture of the page 3 times');
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

  // 29 Oct, his "loose screws": a 48 px figure stood before the words while the
  // agent worked and was gone once the step ended, so the words slid ~56 px
  // sideways on every step. One slot, the same size in every state.
  it('keeps its words in place when a step ends: one icon slot, working, done or failed', () => {
    const search = startActivity('web_search', { query: 'Sibiu' });
    const props = { thinking: null, thinkingComplete: true, durationSec: undefined };
    const { rerender } = render(<MessageChain {...props} steps={[search]} streaming />);
    const working = screen.getByTestId('activity-icon').className;
    expect(screen.getByTestId('activity-icon')).toContainElement(screen.getByTestId('mascot'));

    rerender(<MessageChain {...props} steps={[finishActivity(search, { ok: true, content: '' })]} streaming={false} />);
    expect(screen.getByTestId('activity-icon').className).toBe(working);

    rerender(<MessageChain {...props} steps={[finishActivity(search, { ok: false, content: 'rate limited' })]} streaming={false} />);
    expect(screen.getByTestId('activity-icon').className).toBe(working);
  });

  // 27 Oct, his ask: no card and no pills. The rows still pop in while the agent
  // works; a chat opened again replays nothing.
  it('is a plain line, no card, and pops its rows in only while the agent works', () => {
    const search = startActivity('web_search', { query: 'Rome flights' });
    const live = render(<MessageChain thinking={null} thinkingComplete durationSec={undefined} steps={[search]} streaming />);
    expect(live.container.querySelector('[data-gooey-card]')).toBeNull();
    expect(screen.getByTestId('activity-line').className).not.toMatch(/rounded|border|bg-/);
    fireEvent.click(screen.getByText('Searching the web'));
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
    const read = finishActivity(startActivity('read_file', { path: 'a.png' }), { ok: true, content: '', images: [png(3), png(4), png(5), png(6)] });
    render(<MessageChain thinking={null} thinkingComplete durationSec={undefined} steps={[shot, { ...read, id: 'read' }]} streaming={false} />);
    // Folded: the first look at full width under the line; on the line, the
    // newest three of the rest and how many more. The remote URL never loads.
    expect(screen.getByAltText('What the agent saw when it got there').getAttribute('src')).toBe(png(1));
    const line = screen.getByTestId('step-thumbs').querySelectorAll('img');
    expect([...line].map((i) => i.getAttribute('src'))).toEqual([png(4), png(5), png(6)]);
    expect(screen.getByText('+2')).toBeInTheDocument();
    expect(document.querySelectorAll('img[src^="https:"]')).toHaveLength(0);
    fireEvent.click(screen.getByText(/^Took a picture/));
    // Open: each step carries its own pictures and the line drops its copy. The
    // first picture is a first look, so it is big; the rest are thumbnails.
    expect(screen.getByAltText('What the agent saw when it got there').getAttribute('src')).toBe(png(1));
    const groups = screen.getAllByTestId('step-thumbs');
    expect(groups.map((g) => g.querySelectorAll('img').length)).toEqual([1, 4]);
    expect(screen.queryByText('+2')).not.toBeInTheDocument();
  });

  it('a first look at a new place is big; later pictures from the same place are not', () => {
    const shot = 'data:image/jpeg;base64,/9j/AAAA';
    let n = 0;
    // Own ids: two steps started in the same millisecond share `tool-<ms>`.
    const done = (tool: string, args: Record<string, unknown>, images?: string[]) =>
      ({ ...finishActivity(startActivity(tool, args), { ok: true, content: '', ...(images ? { images } : {}) }), id: `s${n++}` });
    const steps = [
      done('browser', { action: 'open', url: 'florarie.ro/lalele' }),
      done('browser', { action: 'screenshot' }, [shot]),            // first look at florarie.ro
      done('browser', { action: 'click', ref: '3' }),
      done('browser', { action: 'screenshot' }, [shot]),            // same site
      done('web_search', { query: 'lalele' }),                      // a search goes nowhere
      done('browser', { action: 'screenshot' }, [shot]),            // still the same site
      done('computer_use', { action: 'launch', app: 'Notepad' }),
      done('computer_use', { action: 'screenshot', pid: 7 }, [shot]), // first look at Notepad
    ];
    const big = firstLooks(steps);
    expect(steps.map((s) => big.has(s.id))).toEqual([false, true, false, false, false, false, false, true]);
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

  it('a picture the agent took is called one, in an app or in the browser', () => {
    const shot = 'data:image/jpeg;base64,/9j/AAAA';
    const app = startActivity('computer_use', { action: 'screenshot' });
    expect(stepTitle(app)).toBe('Taking a picture');
    expect(stepTitle(finishActivity(startActivity('browser', { action: 'screenshot' }), { ok: true, content: '', images: [shot] })))
      .toBe('Took a picture of the page');
    expect(stepTitle(finishActivity(startActivity('browser', { action: 'click' }), { ok: true, content: '' }))).toBe('Used the browser');
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
    // A step done twice is said once, with how many times (Claude's "captured page 5 times").
    expect(doneSentence([ok('web_search'), ok('read_webpage'), ok('web_search')])).toBe('Searched the web 2 times, read a page');
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

  it('keeps what the person answered on screen after the question card has gone, folded or not', () => {
    const asked = finishActivity(startActivity('ask_user', {}), {
      ok: true,
      content: '',
      data: { answers: [{ selected: ['5.000 – 8.000 lei'] }, { selected: ['Video și grafică'] }] },
    });
    render(<MessageChain thinking={null} thinkingComplete durationSec={undefined} steps={[asked]} streaming={false} />);
    expect(screen.getByTestId('your-answers')).toHaveTextContent('You answered: 5.000 – 8.000 lei · Video și grafică');
  });
});
