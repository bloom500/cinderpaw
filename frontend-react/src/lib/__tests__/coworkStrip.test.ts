import { describe, expect, it } from 'vitest';
import { stripTeammates } from '../coworkStrip';
import type { CoworkExchange } from '@/stores/coworkTranscript';

const ex = (over: Partial<CoworkExchange>): CoworkExchange => ({
  id: 'msg:1', threadId: 't', kind: 'message', fromAgentId: 'human', toAgentId: 'atlas', toName: 'Atlas',
  requestText: 'Find flights', responseText: null, status: 'running', at: 1, startedAt: 1, ...over,
});

describe('stripTeammates', () => {
  it('shows a teammate at work, with its steps', () => {
    const [t] = stripTeammates([ex({ tools: [{ name: 'web_search', done: true }] })], 't', {});
    expect(t).toMatchObject({ name: 'Atlas', state: 'working', task: 'Find flights', tools: [{ name: 'web_search', done: true }] });
  });

  it('shows an answer until it is read, then nothing', () => {
    const done = ex({ status: 'done', responseText: 'Three options.' });
    expect(stripTeammates([done], 't', {})[0]).toMatchObject({ state: 'answered', answer: 'Three options.' });
    expect(stripTeammates([done], 't', { 'msg:1': true })).toEqual([]);
  });

  it('ignores history, approvals, other chats and failures', () => {
    expect(stripTeammates([
      ex({ startedAt: undefined, status: 'done', responseText: 'old' }),
      ex({ id: 'approval:1', kind: 'approval', toAgentId: 'human' }),
      ex({ id: 'msg:2', threadId: 'other' }),
      ex({ id: 'msg:3', toAgentId: 'nova', status: 'error', responseText: 'no' }),
    ], 't', {})).toEqual([]);
    expect(stripTeammates([ex({})], null, {})).toEqual([]);
  });

  it('one card per teammate: the running request wins over an older answer', () => {
    const list = stripTeammates([
      ex({ id: 'msg:1', status: 'done', responseText: 'first' }),
      ex({ id: 'msg:2', requestText: 'Now hotels' }),
    ], 't', {});
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ state: 'working', task: 'Now hotels' });
  });
});
