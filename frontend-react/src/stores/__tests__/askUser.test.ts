import { describe, it, expect, beforeEach } from 'vitest';
import { useAskUser, type AskUserAnswer, type AskUserQuestion } from '@/stores/askUser';

const reset = () =>
  useAskUser.setState({ pending: null, history: [] });

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
});
