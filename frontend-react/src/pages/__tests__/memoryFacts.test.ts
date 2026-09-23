import { describe, it, expect } from 'vitest';
import { factsOf } from '../MemoryLayersPage';

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
});
