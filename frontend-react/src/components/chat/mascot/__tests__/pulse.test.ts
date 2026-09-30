/**
 * Agent Pulse — the label says what the turn is doing, and nothing when there
 * is no turn.
 */

import { describe, it, expect } from 'vitest';
import { pulseLabel } from '../pulse';

describe('pulseLabel', () => {
  it('says nothing when there is no turn', () => {
    for (const state of ['idle', 'typing', 'sleep', 'error', 'curious'] as const) {
      expect(pulseLabel(state, null, false)).toBeNull();
    }
  });

  it('names thinking and done', () => {
    expect(pulseLabel('thinking', null, false)).toBe('Thinking');
    expect(pulseLabel('done', null, false)).toBe('Done');
    expect(pulseLabel('celebrate', null, false)).toBe('Done');
  });

  it('tells a search and a memory lookup apart from any other tool', () => {
    expect(pulseLabel('calling', 'web_search', false)).toBe('Searching');
    expect(pulseLabel('calling', 'deep_research', false)).toBe('Searching');
    expect(pulseLabel('calling', 'recall', false)).toBe('Using memory');
    expect(pulseLabel('calling', 'remember', false)).toBe('Using memory');
    expect(pulseLabel('calling', 'shell_exec', false)).toBe('Running tool');
    expect(pulseLabel('calling', null, false)).toBe('Running tool');
  });

  it('a pending approval outranks whatever the creature shows', () => {
    expect(pulseLabel('thinking', null, true)).toBe('Waiting for approval');
    expect(pulseLabel('idle', null, true)).toBe('Waiting for approval');
  });
});
