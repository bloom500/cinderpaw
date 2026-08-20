import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordArtifact,
  artifactsSnapshot,
  clearArtifacts,
  subscribeArtifacts,
} from '../callArtifacts';
import type { ToolActivity } from '@/hooks/useLiveToolActivity';

function activity(over: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: Math.random().toString(36),
    tool: 'web_search',
    kind: 'browser',
    subject: 'ce este Feral',
    status: 'done',
    startedAt: 1,
    endedAt: 2,
    note: null,
    hits: [{ title: 'T', url: 'https://x.dev', host: 'x.dev', snippet: '', crumbs: '' }],
    files: [],
    output: '',
    cwd: '',
    facts: [],
    error: null,
    ...over,
  };
}

describe('callArtifacts', () => {
  beforeEach(clearArtifacts);

  it('keeps a finished lookup, newest first', () => {
    recordArtifact(activity({ subject: 'first' }));
    recordArtifact(activity({ subject: 'second' }));
    expect(artifactsSnapshot().map((a) => a.subject)).toEqual(['second', 'first']);
  });

  it('ignores a lookup still running — it has no results yet', () => {
    recordArtifact(activity({ status: 'running' }));
    expect(artifactsSnapshot()).toHaveLength(0);
  });

  it('ignores anything with nothing to return to', () => {
    // A shell command's output is in the panel and gone; there is no link, file
    // or fact to come back for, and filing it buries the searches that do have
    // one.
    recordArtifact(activity({ kind: 'terminal', tool: 'shell_exec', hits: [], output: 'ok' }));
    expect(artifactsSnapshot()).toHaveLength(0);
  });

  it('files the same search once, however many times the model repeats it', () => {
    recordArtifact(activity({ subject: 'same' }));
    recordArtifact(activity({ subject: 'same' }));
    expect(artifactsSnapshot()).toHaveLength(1);
  });

  it('replaces the snapshot rather than mutating it, or React never re-renders', () => {
    const before = artifactsSnapshot();
    recordArtifact(activity());
    expect(artifactsSnapshot()).not.toBe(before);
  });

  it('writes through to storage on every change, not on unload', () => {
    // A desktop app is closed by killing its window, and `beforeunload` is the
    // handler that does not run when it matters.
    recordArtifact(activity({ subject: 'persisted' }));
    const raw = localStorage.getItem('feral-call-artifacts');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)[0].subject).toBe('persisted');
    clearArtifacts();
    expect(JSON.parse(localStorage.getItem('feral-call-artifacts')!)).toEqual([]);
  });

  it('notifies subscribers on write and on clear', () => {
    let calls = 0;
    const off = subscribeArtifacts(() => { calls += 1; });
    recordArtifact(activity());
    clearArtifacts();
    off();
    recordArtifact(activity({ subject: 'after unsubscribe' }));
    expect(calls).toBe(2);
  });
});
