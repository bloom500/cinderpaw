import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { lookOf, parseBoard, type Block } from '../board';
import { layoutFlow } from '@/components/board/Flow';
import { BoardView } from '@/components/board/BoardView';

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
