import { describe, expect, it } from 'vitest';
import { thinkingLabel } from '../reasoning';

describe('thinkingLabel', () => {
  it('says nothing about time when nobody measured it', () => {
    // A conversation reopened from disk: the Rust PersistedMessage has no duration field.
    expect(thinkingLabel(false, undefined)).toBe('Reasoning');
  });

  it('shimmers while the model is still thinking, whatever the clock says', () => {
    expect(thinkingLabel(true, undefined)).toBe('Thinking...');
    expect(thinkingLabel(true, 12)).toBe('Thinking...');
    expect(thinkingLabel(false, 0)).toBe('Thinking...');
  });

  it('counts one second in the singular', () => {
    expect(thinkingLabel(false, 1)).toBe('Thought for 1 second');
    expect(thinkingLabel(false, 2)).toBe('Thought for 2 seconds');
  });

  it('switches to minutes past a minute', () => {
    expect(thinkingLabel(false, 59)).toBe('Thought for 59 seconds');
    expect(thinkingLabel(false, 60)).toBe('Thought for 1 minute');
    expect(thinkingLabel(false, 185)).toBe('Thought for 3 minutes');
  });
});
