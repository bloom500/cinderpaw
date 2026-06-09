import { describe, expect, test } from 'vitest';
import { emojiForTool } from '../emojiForTool';

describe('emojiForTool', () => {
  test('known tools get their dedicated emoji', () => {
    expect(emojiForTool('web_search')).toBe('🔍');
    expect(emojiForTool('deep_research')).toBe('🔍');
    expect(emojiForTool('read_url')).toBe('📖');
    expect(emojiForTool('read_webpage')).toBe('📖');
    expect(emojiForTool('fetch_url')).toBe('📖');
    expect(emojiForTool('http_request')).toBe('🌐');
    expect(emojiForTool('read_file')).toBe('📄');
    expect(emojiForTool('edit_file')).toBe('✏️');
    expect(emojiForTool('write_file')).toBe('✏️');
    expect(emojiForTool('shell_exec')).toBe('🐚');
    expect(emojiForTool('calculator')).toBe('🧮');
    expect(emojiForTool('time_date')).toBe('⏰');
    expect(emojiForTool('read_skill')).toBe('📚');
    expect(emojiForTool('ask_user')).toBe('❓');
    expect(emojiForTool('memory_ops')).toBe('🧠');
    expect(emojiForTool('todo_write')).toBe('📋');
    expect(emojiForTool('file_search')).toBe('📁');
    expect(emojiForTool('grep')).toBe('🔎');
  });

  test('git_* tools get 🌿', () => {
    expect(emojiForTool('git_status')).toBe('🌿');
    expect(emojiForTool('git_diff')).toBe('🌿');
    expect(emojiForTool('git_log')).toBe('🌿');
    expect(emojiForTool('git_branch')).toBe('🌿');
    expect(emojiForTool('git_commit')).toBe('🌿');
  });

  test('code-quality:* tools get 🔨', () => {
    expect(emojiForTool('code-quality:run_tests')).toBe('🔨');
    expect(emojiForTool('code-quality:format_code')).toBe('🔨');
    expect(emojiForTool('code-quality:build_project')).toBe('🔨');
  });

  test('unknown tool gets fallback 🔧', () => {
    expect(emojiForTool('future_tool_we_havent_invented')).toBe('🔧');
  });
});
