import { describe, it, expect, beforeEach } from 'vitest';
import { useAskUser, type AskUserAnswer, type AskUserQuestion } from '@/stores/askUser';

const reset = () =>
  useAskUser.setState({ pending: null, waiting: [], history: [] });

const SAMPLE_QUESTIONS: AskUserQuestion[] = [
  {
    question: 'Pick a database',
    options: [
      { label: 'PostgreSQL', recommended: true },
      { label: 'SQLite' },
    ],
    multiSelect: false,
  },
];

describe('useAskUser', () => {
  beforeEach(reset);

  it('starts with no pending request', () => {
    expect(useAskUser.getState().pending).toBeNull();
    expect(useAskUser.getState().isPending()).toBe(false);
  });

  it('request() sets a pending request and returns a Promise', async () => {
    const promise = useAskUser.getState().request('req-1', 'sess-1', SAMPLE_QUESTIONS);
    const pending = useAskUser.getState().pending;
    expect(pending).not.toBeNull();
    expect(pending?.id).toBe('req-1');
    expect(pending?.sessionId).toBe('sess-1');
    expect(pending?.questions).toEqual(SAMPLE_QUESTIONS);
    expect(useAskUser.getState().isPending()).toBe(true);

    // Resolve so the promise does not hang.
    useAskUser.getState().submit([{ question: 'Pick a database', selected: ['PostgreSQL'] }]);
    const answers = await promise;
    expect(answers).toEqual([{ question: 'Pick a database', selected: ['PostgreSQL'] }]);
  });

  it('submit() archives the request into history', () => {
    void useAskUser.getState().request('req-2', 'sess-2', SAMPLE_QUESTIONS);
    const answers: AskUserAnswer[] = [
      { question: 'Pick a database', selected: ['SQLite'] },
    ];
    useAskUser.getState().submit(answers);
    const state = useAskUser.getState();
    expect(state.pending).toBeNull();
    expect(state.history).toHaveLength(1);
    expect(state.history[0]).toMatchObject({
      id: 'req-2',
      sessionId: 'sess-2',
      questions: SAMPLE_QUESTIONS,
      answers,
    });
    expect(state.history[0]?.answeredAt).toBeGreaterThanOrEqual(state.history[0]?.askedAt ?? 0);
  });

  it('cancel() rejects the pending Promise and clears pending', async () => {
    const promise = useAskUser.getState().request('req-3', 'sess-3', SAMPLE_QUESTIONS);
    promise.catch(() => {}); // suppress unhandled rejection
    useAskUser.getState().cancel('user dismissed');
    expect(useAskUser.getState().pending).toBeNull();
    await expect(promise).rejects.toThrow(/user dismissed/);
  });

  it('cancel() with no pending request is a no-op', () => {
    expect(() => useAskUser.getState().cancel('x')).not.toThrow();
  });

  it('submit() with no pending request is a no-op', () => {
    expect(() => useAskUser.getState().submit([])).not.toThrow();
    expect(useAskUser.getState().history).toHaveLength(0);
  });

  // --- Queue behaviour: the control_app regression (successive ask_user) ---

  it('queues a second request instead of overwriting the first', async () => {
    const s = useAskUser.getState();
    const p1 = s.request('a', 'sess', SAMPLE_QUESTIONS);
    const p2 = s.request('b', 'sess', SAMPLE_QUESTIONS);

    // First is head, second is queued — neither Promise is dropped.
    expect(useAskUser.getState().pending?.id).toBe('a');
    expect(useAskUser.getState().waiting.map((w) => w.id)).toEqual(['b']);

    // Answer the head → it resolves AND the queued one is promoted.
    useAskUser.getState().submit([{ question: 'Pick a database', selected: ['SQLite'] }]);
    await expect(p1).resolves.toEqual([{ question: 'Pick a database', selected: ['SQLite'] }]);
    expect(useAskUser.getState().pending?.id).toBe('b');
    expect(useAskUser.getState().waiting).toHaveLength(0);

    // Answer the promoted one → it resolves too (previously hung forever).
    useAskUser.getState().submit([{ question: 'Pick a database', selected: ['PostgreSQL'] }]);
    await expect(p2).resolves.toEqual([{ question: 'Pick a database', selected: ['PostgreSQL'] }]);
    expect(useAskUser.getState().pending).toBeNull();
  });

  it('cancelById rejects a queued request without disturbing the head', async () => {
    const s = useAskUser.getState();
    const p1 = s.request('a', 'sess', SAMPLE_QUESTIONS);
    const p2 = s.request('b', 'sess', SAMPLE_QUESTIONS);
    p2.catch(() => {}); // suppress unhandled rejection

    useAskUser.getState().cancelById('b', 'sidecar timeout');
    await expect(p2).rejects.toThrow(/sidecar timeout/);
    // Head untouched and still answerable.
    expect(useAskUser.getState().pending?.id).toBe('a');
    expect(useAskUser.getState().waiting).toHaveLength(0);
    useAskUser.getState().submit([{ question: 'Pick a database', selected: ['SQLite'] }]);
    await expect(p1).resolves.toBeDefined();
  });

  it('cancelAll rejects the head and every queued request', async () => {
    const s = useAskUser.getState();
    const p1 = s.request('a', 'sess', SAMPLE_QUESTIONS);
    const p2 = s.request('b', 'sess', SAMPLE_QUESTIONS);
    const p3 = s.request('c', 'sess', SAMPLE_QUESTIONS);
    const settled = Promise.allSettled([p1, p2, p3]);
    useAskUser.getState().cancelAll('shutdown');
    const results = await settled;
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(useAskUser.getState().pending).toBeNull();
    expect(useAskUser.getState().waiting).toHaveLength(0);
  });
});
