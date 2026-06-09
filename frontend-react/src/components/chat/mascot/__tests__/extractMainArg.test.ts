import { describe, expect, test } from 'vitest';
import { extractMainArg } from '../extractMainArg';

describe('extractMainArg', () => {
  test('web_search → query', () => {
    expect(extractMainArg('web_search', { query: 'agenti marketing RO' }))
      .toBe('agenti marketing RO');
  });

  test('read_url → url with protocol stripped', () => {
    expect(extractMainArg('read_url', { url: 'https://clutch.co/ro' }))
      .toBe('clutch.co/ro');
  });

  test('read_file → basename', () => {
    expect(extractMainArg('read_file', { path: 'src/components/Button.tsx' }))
      .toBe('Button.tsx');
  });

  test('edit_file → basename', () => {
    expect(extractMainArg('edit_file', { path: 'src/foo.ts' })).toBe('foo.ts');
  });

  test('write_file → basename', () => {
    expect(extractMainArg('write_file', { path: '/abs/path/to/file.txt' }))
      .toBe('file.txt');
  });

  test('shell_exec → command truncated to 40 chars', () => {
    const cmd = "git log --oneline -n 50 --author='someone' --since='2024-01-01'";
    const out = extractMainArg('shell_exec', { command: cmd });
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(40);
    expect(out).toBe(cmd.slice(0, 40));
  });

  test('git_commit → message truncated to 40 chars', () => {
    const msg = 'feat: add a new feature that does something important to the user';
    const out = extractMainArg('git_commit', { message: msg });
    expect(out).toBe(msg.slice(0, 40));
  });

  test('read_skill → Skill: <name>', () => {
    expect(extractMainArg('read_skill', { id: 'deep-research' }))
      .toBe('Skill: deep-research');
  });

  test('ask_user → N questions', () => {
    const out = extractMainArg('ask_user', {
      questions: [
        { question: 'q1', options: [], multiSelect: false },
        { question: 'q2', options: [], multiSelect: false },
        { question: 'q3', options: [], multiSelect: false },
      ],
    });
    expect(out).toBe('3 questions');
  });

  test('calculator → expression', () => {
    expect(extractMainArg('calculator', { expression: '1200*5' })).toBe('1200*5');
  });

  test('file_search → pattern', () => {
    expect(extractMainArg('file_search', { pattern: '**/*.test.ts' }))
      .toBe('**/*.test.ts');
  });

  test('grep → pattern', () => {
    expect(extractMainArg('grep', { pattern: 'TODO' })).toBe('TODO');
  });

  test('memory_ops → action', () => {
    expect(extractMainArg('memory_ops', { action: 'search' })).toBe('search');
  });

  test('todo_write → action + count', () => {
    const out = extractMainArg('todo_write', {
      action: 'add',
      items: [{ id: 'a' }, { id: 'b' }],
    });
    expect(out).toContain('add');
  });

  test('deep_research → query', () => {
    expect(extractMainArg('deep_research', { query: 'agenti RO' }))
      .toBe('agenti RO');
  });

  test('time_date → format', () => {
    expect(extractMainArg('time_date', { format: 'YYYY-MM-DD' }))
      .toBe('YYYY-MM-DD');
  });

  test('git_status / git_diff / git_log / git_branch with no args → null', () => {
    expect(extractMainArg('git_status', {})).toBeNull();
    expect(extractMainArg('git_diff', {})).toBeNull();
    expect(extractMainArg('git_log', {})).toBeNull();
    expect(extractMainArg('git_branch', {})).toBeNull();
  });

  test('unknown tool falls back to first string arg or null', () => {
    expect(extractMainArg('mystery_tool', { foo: 'bar' })).toBe('bar');
    expect(extractMainArg('mystery_tool', { foo: 42 })).toBeNull();
    expect(extractMainArg('mystery_tool', {})).toBeNull();
  });

  test('truncates long results to 50 chars (except for read_skill at 30)', () => {
    const long = 'x'.repeat(100);
    expect(extractMainArg('web_search', { query: long })!.length).toBe(50);
    expect(extractMainArg('read_skill', { id: 'y'.repeat(100) })!.length)
      .toBeLessThanOrEqual(30);
  });
});
