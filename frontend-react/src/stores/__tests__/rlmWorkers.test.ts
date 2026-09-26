import { beforeEach, describe, expect, it } from 'vitest';
import { displayName, RLM_WORKERS_MAX, useRlmWorkers, workersFor, type RlmWorkerEvent } from '../rlmWorkers';

const ev = (over: Partial<RlmWorkerEvent> = {}): RlmWorkerEvent => ({
  sessionId: 's1',
  childId: 'sa-1',
  name: 'subagent-count-the-files-a1b2',
  status: 'running',
  ...over,
});

describe('rlm workers store', () => {
  beforeEach(() => useRlmWorkers.setState({ workers: [] }));

  it('creates one row and UPDATES it, never stacking duplicates', () => {
    const s = useRlmWorkers.getState();
    s.upsert(ev({ detail: 'starting' }));
    s.upsert(ev({ detail: 'tool_start grep' }));
    const { workers } = useRlmWorkers.getState();
    expect(workers).toHaveLength(1);
    expect(workers[0]).toMatchObject({ detail: 'tool_start grep', status: 'running' });
  });

  it('keeps the original startedAt across updates, so the timer is honest', () => {
    useRlmWorkers.getState().upsert(ev());
    const started = useRlmWorkers.getState().workers[0].startedAt;
    useRlmWorkers.getState().upsert(ev({ detail: 'later' }));
    expect(useRlmWorkers.getState().workers[0].startedAt).toBe(started);
  });

  it('keeps the answer from the settling event', () => {
    const s = useRlmWorkers.getState();
    s.upsert(ev());
    s.upsert(ev({ status: 'completed', detail: '3 tool call(s)', answer: '42 files' }));
    expect(useRlmWorkers.getState().workers[0]).toMatchObject({ status: 'completed', answer: '42 files' });
    expect(useRlmWorkers.getState().workers[0].endedAt).toBeTypeOf('number');
  });

  it('keeps cancelled distinct from error', () => {
    // A worker the person stopped is not a worker that broke.
    const s = useRlmWorkers.getState();
    s.upsert(ev({ status: 'cancelled' }));
    s.upsert(ev({ childId: 'sa-2', status: 'error' }));
    expect(useRlmWorkers.getState().workers.map((w) => w.status)).toEqual(['cancelled', 'error']);
  });

  it('shows a chat only its own workers', () => {
    const s = useRlmWorkers.getState();
    s.upsert(ev());
    s.upsert(ev({ childId: 'sa-2', sessionId: 's2' }));
    const all = useRlmWorkers.getState().workers;
    expect(workersFor(all, 's1').map((w) => w.childId)).toEqual(['sa-1']);
    expect(workersFor(all, null)).toEqual([]);
  });

  it('clears the settled workers of one chat and keeps the running ones', () => {
    const s = useRlmWorkers.getState();
    s.upsert(ev({ status: 'completed' }));
    s.upsert(ev({ childId: 'sa-2' }));
    s.upsert(ev({ childId: 'sa-3', sessionId: 's2', status: 'completed' }));
    s.clearSettled('s1');
    expect(useRlmWorkers.getState().workers.map((w) => w.childId)).toEqual(['sa-2', 'sa-3']);
  });

  it('is bounded', () => {
    const s = useRlmWorkers.getState();
    for (let i = 0; i < RLM_WORKERS_MAX + 5; i++) s.upsert(ev({ childId: `sa-${i}` }));
    expect(useRlmWorkers.getState().workers).toHaveLength(RLM_WORKERS_MAX);
  });
});

describe('displayName', () => {
  it('drops the generated prefix and id tail, keeping the task words', () => {
    expect(displayName('subagent-count-the-files-a1b2')).toBe('count the files');
  });
  it('shows a name the model chose as it is', () => {
    expect(displayName('api-reviewer')).toBe('api reviewer');
  });
});
