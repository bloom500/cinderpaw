import { describe, it, expect, beforeEach } from 'vitest';
import { DRAFT_KEY, readDraft, writeDraft } from '../ChatInput';

// The composer's draft rules, exercised against the composer's own helpers —
// not a copy of them. A test that reimplements what it checks passes forever,
// including on the day the real thing changes.
//
// Kept to the storage contract rather than rendering the whole composer: what
// broke was LEAVING, and leaving is not a click.

beforeEach(() => window.localStorage.clear());

describe('the composer draft', () => {
  it('survives being written and read back', () => {
    writeDraft('c1', 'half a sentence');
    expect(readDraft('c1')).toBe('half a sentence');
  });

  it('belongs to one conversation only', () => {
    writeDraft('c1', 'for the first');
    expect(readDraft('c2')).toBe('');
  });

  it('a fresh machine has no draft and does not throw', () => {
    expect(readDraft('never-opened')).toBe('');
  });

  it('a sent message leaves no key behind', () => {
    writeDraft('c1', 'typed');
    writeDraft('c1', '');
    expect(window.localStorage.getItem(DRAFT_KEY('c1'))).toBeNull();
  });

  it('whitespace is not a draft', () => {
    writeDraft('c1', '   \n  ');
    expect(window.localStorage.getItem(DRAFT_KEY('c1'))).toBeNull();
  });
});
