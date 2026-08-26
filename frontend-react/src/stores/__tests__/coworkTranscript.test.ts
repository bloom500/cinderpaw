import { describe, expect, test } from 'vitest';
import {
  applyCoworkEvent,
  COWORK_TRANSCRIPT_MAX,
  fromHistory,
  useCoworkTranscript,
  type CoworkExchange,
} from '../coworkTranscript';

function msgReceived(overrides: Partial<Parameters<typeof applyCoworkEvent>[1]> = {}) {
  return {
    eventType: 'message_received',
    agentId: 'bob',
    threadId: 't1',
    title: 'alice → bob',
    data: { messageId: 'm1', fromAgentId: 'alice', body: 'count the files' },
    ...overrides,
  };
}

describe('applyCoworkEvent (A2A transcript reducer)', () => {
  test('message_received opens a running exchange carrying the REAL message text', () => {
    const out = applyCoworkEvent([], msgReceived());
    expect(out).toHaveLength(1);
    const e = out[0];
    expect(e.id).toBe('msg:m1');
    expect(e.kind).toBe('message');
    expect(e.fromAgentId).toBe('alice');
    expect(e.toAgentId).toBe('bob');
    expect(e.requestText).toBe('count the files');
    expect(e.responseText).toBeNull();
    expect(e.status).toBe('running');
  });

  test('received→processed is ONE exchange that gains the real reply text', () => {
    let out = applyCoworkEvent([], msgReceived());
    out = applyCoworkEvent(out, {
      eventType: 'message_processed',
      agentId: 'bob',
      threadId: 't1',
      title: 'alice → bob',
      data: { messageId: 'm1', output: 'done — 42 files' },
    });
    expect(out).toHaveLength(1);
    expect(out[0].requestText).toBe('count the files');
    expect(out[0].responseText).toBe('done — 42 files');
    expect(out[0].status).toBe('done');
  });

  test('rejected keeps the request but records the reason as an error', () => {
    let out = applyCoworkEvent([], msgReceived());
    out = applyCoworkEvent(out, {
      eventType: 'message_rejected',
      agentId: 'bob',
      title: 'alice → bob',
      data: { messageId: 'm1', reason: 'hops exceeded' },
    });
    expect(out[0].status).toBe('error');
    expect(out[0].responseText).toBe('hops exceeded');
  });

  test('human sender maps to fromAgentId "human"', () => {
    const out = applyCoworkEvent([], msgReceived({ data: { messageId: 'm2', fromAgentId: 'human', body: 'hi' } }));
    expect(out[0].fromAgentId).toBe('human');
  });

  test('handoff flow: summary in, result out, failed carries reason', () => {
    let out = applyCoworkEvent([], {
      eventType: 'handoff_received',
      agentId: 'carol',
      threadId: undefined,
      title: 'bob ⇢ carol: fix the parser',
      data: { handoffId: 'h1', fromAgentId: 'bob', summary: 'fix the parser' },
    });
    expect(out[0]).toMatchObject({
      id: 'handoff:h1',
      kind: 'handoff',
      fromAgentId: 'bob',
      toAgentId: 'carol',
      requestText: 'fix the parser',
      status: 'running',
    });
    out = applyCoworkEvent(out, {
      eventType: 'handoff_completed',
      agentId: 'carol',
      title: '',
      data: { handoffId: 'h1', result: 'parser fixed' },
    });
    expect(out[0].responseText).toBe('parser fixed');
    expect(out[0].status).toBe('done');

    let failed = applyCoworkEvent([], {
      eventType: 'handoff_received',
      agentId: 'carol',
      title: '',
      data: { handoffId: 'h2', fromAgentId: 'bob', summary: 'x' },
    });
    failed = applyCoworkEvent(failed, {
      eventType: 'handoff_failed',
      agentId: 'carol',
      title: '',
      data: { handoffId: 'h2', reason: 'deadline' },
    });
    expect(failed[0].status).toBe('error');
    expect(failed[0].responseText).toBe('deadline');
  });

  test('approval flow asks the human and closes on the terminal verdict', () => {
    let out = applyCoworkEvent([], {
      eventType: 'approval_requested',
      agentId: 'bob',
      title: '🔐 bob: rm -rf dist/',
      data: { requestId: 'r1', approvalClass: 'delete', description: 'rm -rf dist/' },
    });
    expect(out[0]).toMatchObject({
      id: 'approval:r1',
      kind: 'approval',
      fromAgentId: 'bob',
      toAgentId: 'human',
      requestText: 'rm -rf dist/',
      approvalClass: 'delete',
      status: 'running',
    });
    for (const [eventType, status] of [
      ['approval_approved', 'done'],
      ['approval_denied', 'error'],
      ['approval_expired', 'error'],
    ] as const) {
      const next = applyCoworkEvent(out, { eventType, agentId: 'bob', title: '', data: { requestId: 'r1' } });
      expect(next).toHaveLength(1);
      expect(next[0].status).toBe(status);
    }
  });

  test('a terminal event seen FIRST still produces a usable exchange', () => {
    // Panel mounted mid-flow: processed arrives with no received before it.
    const out = applyCoworkEvent([], {
      eventType: 'message_processed',
      agentId: 'bob',
      title: '',
      data: { messageId: 'm9', output: '42' },
    });
    expect(out[0].id).toBe('msg:m9');
    expect(out[0].responseText).toBe('42');
    expect(out[0].status).toBe('done');
  });

  test('caps the transcript at COWORK_TRANSCRIPT_MAX entries, oldest out', () => {
    let out: CoworkExchange[] = [];
    for (let i = 0; i < COWORK_TRANSCRIPT_MAX + 10; i++) {
      out = applyCoworkEvent(out, msgReceived({
        data: { messageId: `m${i}`, fromAgentId: 'alice', body: `msg ${i}` },
      }));
    }
    expect(out).toHaveLength(COWORK_TRANSCRIPT_MAX);
    expect(out.at(-1)!.id).toBe(`msg:m${COWORK_TRANSCRIPT_MAX + 9}`);
    expect(out[0].id).toBe('msg:m10');
  });
});

describe('fromHistory — the transcript rebuilt from the mailbox', () => {
  const rows = [
    {
      id: 'r1',
      fromAgentId: 'human',
      toAgentId: 'atlas',
      toAgentName: 'Atlas',
      body: 'summarise perception',
      status: 'processed',
      createdAt: 1000,
    },
    {
      id: 'r2',
      fromAgentId: 'atlas',
      fromAgentName: 'Atlas',
      toAgentId: 'bolt',
      toAgentName: 'Bolt',
      body: 'check the tests',
      status: 'pending',
      createdAt: 2000,
    },
  ];

  test('every stored row becomes one message, in order', () => {
    const out = fromHistory('conv-1', rows);
    expect(out.map((e) => e.requestText)).toEqual(['summarise perception', 'check the tests']);
    expect(out.every((e) => e.threadId === 'conv-1')).toBe(true);
  });

  test('names survive the round trip, so the panel never shows raw ids', () => {
    const out = fromHistory('conv-1', rows);
    expect(out[0]?.toName).toBe('Atlas');
    expect(out[1]?.fromName).toBe('Atlas');
  });

  test('status maps honestly: pending is still running, rejected is an error', () => {
    const out = fromHistory('c', [
      { ...rows[0]!, id: 'a', status: 'processed' },
      { ...rows[0]!, id: 'b', status: 'pending' },
      { ...rows[0]!, id: 'c', status: 'rejected' },
    ]);
    expect(out.map((e) => e.status)).toEqual(['done', 'running', 'error']);
  });

  test('no elapsed clock on replayed rows', () => {
    // A timer counting from a turn that ended yesterday would be a lie, and a
    // restart cannot resume one.
    expect(fromHistory('c', rows).every((e) => e.startedAt === undefined)).toBe(true);
  });

  test('hydrate REPLACES, so switching chats does not leak the previous one', () => {
    useCoworkTranscript.setState({
      exchanges: fromHistory('old-chat', [{ ...rows[0]!, id: 'old', body: 'from another chat' }]),
    });
    useCoworkTranscript.getState().hydrate('conv-1', rows);
    const texts = useCoworkTranscript.getState().exchanges.map((e) => e.requestText);
    expect(texts).not.toContain('from another chat');
    expect(texts).toContain('summarise perception');
  });

  test('an empty thread clears the panel rather than leaving stale traffic', () => {
    useCoworkTranscript.getState().hydrate('conv-2', []);
    expect(useCoworkTranscript.getState().exchanges).toEqual([]);
  });
});
