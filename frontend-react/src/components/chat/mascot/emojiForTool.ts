/**
 * Maps a tool name to a single emoji used in the bubble's left edge.
 *
 * The map is exhaustive over the tools currently registered in
 * `FeralAgent/src/index.ts`. Keep in sync with `extractMainArg.ts`.
 */

const EMOJI: Record<string, string> = {
  web_search: '🔍',
  deep_research: '🔍',
  read_url: '📖',
  read_webpage: '📖',
  fetch_url: '📖',
  http_request: '🌐',
  read_file: '📄',
  edit_file: '✏️',
  write_file: '✏️',
  shell_exec: '🐚',
  calculator: '🧮',
  time_date: '⏰',
  read_skill: '📚',
  ask_user: '❓',
  memory_ops: '🧠',
  todo_write: '📋',
  file_search: '📁',
  grep: '🔎',
  git_status: '🌿',
  git_diff: '🌿',
  git_log: '🌿',
  git_commit: '🌿',
  git_branch: '🌿',
  'code-quality:run_tests': '🔨',
  'code-quality:format_code': '🔨',
  'code-quality:lint_code': '🔨',
  'code-quality:build_project': '🔨',
  'code-quality:install_deps': '🔨',
  tool_health: '📊',
  scan_workspace: '🛡️',
};

export function emojiForTool(toolName: string): string {
  return EMOJI[toolName] ?? '🔧';
}
