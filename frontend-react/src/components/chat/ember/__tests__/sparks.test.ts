import { describe, it, expect } from 'vitest';
import type { ToolCallEvent } from '@/stores/chat';
import { takeNewSparks } from '../sparks';

const tool = (id: string, name: string, startedAt: number): ToolCallEvent => ({
  id, kind: 'tool', name, emoji: '', mainArg: null, status: 'running', startedAt, endedAt: null,
});

describe('takeNewSparks', () => {
  it('throws one spark per new tool call, by kind', () => {
    expect(takeNewSparks([tool('a', 'web_search', 10), tool('b', 'read_file', 11)], new Set(), 0)).toEqual(['search', 'read']);
  });

  it('never throws the same call twice', () => {
    const seen = new Set<string>();
    const stream = [tool('a', 'web_search', 10)];
    takeNewSparks(stream, seen, 0);
    expect(takeNewSparks([...stream, tool('b', 'shell_exec', 12)], seen, 0)).toEqual(['build']);
  });

  it('ignores calls from before the panel opened', () => {
    expect(takeNewSparks([tool('old', 'web_search', 5), tool('new', 'grep', 20)], new Set(), 10)).toEqual(['read']);
  });

  it('ignores context entries', () => {
    const ctx = { id: 'c', kind: 'context', label: 'Compacting', startedAt: 20 } as ToolCallEvent;
    expect(takeNewSparks([ctx], new Set(), 0)).toEqual([]);
  });
});
