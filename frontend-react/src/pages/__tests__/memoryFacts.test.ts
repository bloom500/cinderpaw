import { describe, it, expect } from 'vitest';
import { factsOf, kindOf, whenLabel } from '../MemoryLayersPage';

describe('memory page rows', () => {
  it('shows one fact per edge, subject relation object, not two bare nodes', () => {
    const rows = factsOf({
      nodes: [
        { id: 'language', label: 'language', type: 'entity', touched_at: 10 },
        { id: 'romanian', label: 'Romanian', type: 'concept', touched_at: 20 },
        { id: 'orphan', label: 'orphan', type: 'entity', touched_at: 5 },
      ],
      edges: [{ from: 'language', to: 'romanian', relation: 'is' }],
    });
    expect(rows.map((r) => r.label)).toEqual(['Language: Romanian', 'orphan']);
    expect(rows[0]!.touched_at).toBe(20);
    // The edge rides along: it is what the page's Forget sends back to the agent.
    expect(rows[0]!.edge?.from).toBe('language');
    expect(rows[1]!.edge).toBeUndefined();
  });

  it('files the engine categories under three kinds, Fact when unknown', () => {
    expect(kindOf('preference')).toBe('preference');
    expect(['goal', 'decision', 'commitment', 'event'].map(kindOf)).toEqual(['project', 'project', 'project', 'project']);
    expect(['fact', 'relationship', 'context'].map(kindOf)).toEqual(['fact', 'fact', 'fact']);
    // An older engine sends no category at all.
    expect(kindOf(undefined)).toBe('fact');
  });

  it('says when in calendar days', () => {
    const now = new Date(2026, 8, 28, 0, 10).getTime();
    expect(whenLabel(now, new Date(2026, 8, 28, 0, 5).getTime())).toBe('Today');
    // Twenty minutes ago, but yesterday on the calendar.
    expect(whenLabel(now, new Date(2026, 8, 27, 23, 50).getTime())).toBe('Yesterday');
    expect(whenLabel(now, new Date(2026, 8, 25, 12).getTime())).toBe('3 days ago');
    expect(whenLabel(now, new Date(2026, 8, 18, 12).getTime())).toBe('Last week');
  });
});
