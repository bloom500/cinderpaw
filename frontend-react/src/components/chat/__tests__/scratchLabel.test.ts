import { describe, expect, it } from 'vitest';
import { scratchLabel } from '../MessageItem';

describe('scratchLabel', () => {
  it('says nothing when the agent did not touch its scratchpad', () => {
    // Most turns. A permanent "0 edits" row is what trains people to skip the line.
    expect(scratchLabel(undefined)).toBeNull();
    expect(scratchLabel({ edits: 0, added: 0, removed: 0 })).toBeNull();
  });

  it('reads as one line for a single append', () => {
    expect(scratchLabel({ edits: 1, added: 71, removed: 0 })).toBe('1 scratchpad edit +71');
  });

  it('pluralises and shows removals when there were any', () => {
    expect(scratchLabel({ edits: 3, added: 120, removed: 8 })).toBe('3 scratchpad edits +120 -8');
  });

  it('still reports an edit that only removed lines', () => {
    // added === 0 is not "nothing happened" — deleting 40 lines is the edit most
    // worth telling someone about.
    expect(scratchLabel({ edits: 1, added: 0, removed: 40 })).toBe('1 scratchpad edit +0 -40');
  });
});
