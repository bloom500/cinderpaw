import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { lookOf, parseBoard, type Block } from '../board';
import { layoutFlow, perRow } from '@/components/board/Flow';
import { BoardView } from '@/components/board/BoardView';
import { Photo } from '@/components/board/sections';

const FLOW: Extract<Block, { kind: 'flow' }> = {
  kind: 'flow',
  nodes: [
    { id: 'out', title: 'Output' }, { id: 'in', title: 'Inputs' }, { id: 'lo', title: 'Logic' },
    { id: 'au', title: 'Automation' }, { id: 'ext', title: 'External Tools' },
  ],
  edges: [{ from: 'in', to: 'lo' }, { from: 'lo', to: 'au' }, { from: 'au', to: 'out' }, { from: 'lo', to: 'ext', dashed: true }, { from: 'ext', to: 'au', dashed: true }],
};

describe('parseBoard', () => {
  it('reads a board and drops a block it cannot draw instead of crashing on it', () => {
    const b = parseBoard(JSON.stringify({ title: 'T', blocks: [{ kind: 'text', text: 'hi' }, { kind: 'bars', items: 'nope' }, { kind: 'laser' }] }));
    expect(b?.blocks).toEqual([{ kind: 'text', text: 'hi' }]);
  });

  // A series shorter than its labels threw while drawing and took the window down.
  it('drops a line chart whose series do not match its labels', () => {
    const line = (values: unknown[]) => ({ kind: 'line', x: ['a', 'b', 'c'], series: [{ values }] });
    const b = parseBoard(JSON.stringify({ title: 'T', blocks: [line([]), line([1, 2]), line([1, 2, 3]), { kind: 'text', text: 'ok' }] }));
    expect(b?.blocks.map((x) => x.kind)).toEqual(['line', 'text']);
  });

  it('is null for text that is not a board', () => {
    expect(parseBoard('# a markdown file')).toBeNull();
    expect(parseBoard(JSON.stringify({ blocks: [] }))).toBeNull();
  });
});

describe('lookOf: the same board looks the same, two boards do not', () => {
  it('is stable for one seed', () => {
    expect(lookOf('a1:Trip')).toEqual(lookOf('a1:Trip'));
  });

  it('differs across many boards, and starts warm every time', () => {
    const looks = Array.from({ length: 40 }, (_, i) => lookOf(`id${i}:Board ${i}`));
    const distinct = new Set(looks.map((l) => JSON.stringify(l)));
    expect(distinct.size).toBeGreaterThan(30);
    const warm = ['ember', 'apricot', 'rose', 'sand', 'gold'];
    for (const l of looks) {
      expect(l.tints.slice(0, 5).every((t) => warm.includes(t))).toBe(true);
      expect(l.accent).not.toBe('sand');
    }
  });
});

describe('layoutFlow', () => {
  it('puts the solid chain in a row in walking order and the dashed-only node below', () => {
    expect(layoutFlow(FLOW)).toEqual({ main: ['in', 'lo', 'au', 'out'], side: ['ext'] });
  });
});

// 2 Oct: six steps in an 880px board scrolled sideways and cut "Evanghelizează" to "Evangheli".
describe('perRow', () => {
  it('keeps one row when the cards fit, else splits into even rows instead of scrolling', () => {
    expect(perRow(4, 1100)).toBe(4);
    expect(perRow(6, 880)).toBe(3);
    expect(perRow(7, 880)).toBe(4);
    expect(perRow(6, 300)).toBe(1);
    expect(perRow(6, 0)).toBe(6);
  });
});

describe('BoardView', () => {
  it('draws the header, the blocks, and the flow nodes as the legend when no chips were given', () => {
    render(<BoardView board={{ title: 'System Diagram', subtitle: 'Workflow overview', icon: 'workflow', blocks: [FLOW] }} seed="x" status="Generated" />);
    expect(screen.getByRole('heading', { name: 'System Diagram' })).toBeTruthy();
    expect(screen.getByText('Workflow overview')).toBeTruthy();
    expect(screen.getByText('Generated')).toBeTruthy();
    // Once as a node, once as a chip.
    expect(screen.getAllByText('Logic')).toHaveLength(2);
    expect(screen.getAllByText('External Tools')).toHaveLength(1);
  });

  it('keeps a line that falls below zero inside the chart', () => {
    const { container } = render(<BoardView board={{ title: 'P&L', blocks: [{ kind: 'line', x: ['Q1', 'Q2', 'Q3'], series: [{ values: [4, -6, 10] }] }] }} seed="n" status="Ready" />);
    const dots = Array.from(container.querySelectorAll('circle')).map((c) => Number(c.getAttribute('cy')));
    const ys = (container.querySelector('path[stroke-width="3"]')?.getAttribute('d') ?? '').match(/-?\d+(\.\d+)?/g)!.map(Number).filter((_, i) => i % 2 === 1);
    // Inside the 240-high drawing (before: the -6 landed at y 328, under the labels and off the card).
    for (const v of [...dots, ...ys]) expect(v).toBeLessThanOrEqual(240);
  });

  it("uses the board's own status word when it gave one", () => {
    render(<BoardView board={{ title: 'GTM', status: 'draft', blocks: [{ kind: 'text', text: 'x' }] }} seed="y" status="Generated" />);
    expect(screen.getByText('Draft')).toBeTruthy();
  });

  it('a picture that is not there leaves a tinted tile, never a broken image', () => {
    const { container } = render(<BoardView board={{ title: 'Trip', blocks: [{ kind: 'calendar', days: [{ day: 'Mon', title: 'Walk' }] }] }} seed="z" status="Ready" />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('Walk')).toBeTruthy();
  });
});

// Two of eight Openverse thumbnails failed on the Tokyo board (1 Oct) and drew
// empty tinted frames; the same addresses loaded a minute later.
describe('Photo', () => {
  it('retries once, then shows its fallback instead of an empty frame', () => {
    vi.useFakeTimers();
    const { container } = render(<Photo src="https://x.test/a.jpg" fallback={<span>vignette</span>} />);
    fireEvent.error(container.querySelector('img')!);
    act(() => vi.advanceTimersByTime(1500));
    expect(container.querySelector('img')).not.toBeNull();
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('vignette')).toBeTruthy();
    vi.useRealTimers();
  });
});
