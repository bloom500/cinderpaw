/**
 * Single source of truth for "what to show in the bubble for this tool call".
 *
 * The switch is exhaustive over the tools currently registered in
 * `FeralAgent/src/index.ts`. When a new tool is added there, add a case
 * here — and add a test in `extractMainArg.test.ts`.
 */

const MAX_LEN = 50;

function truncate(s: string, max = MAX_LEN): string {
  return s.length > max ? s.slice(0, max) : s;
}

function basename(path: string): string {
  const m = path.match(/[^/\\]+$/);
  return m ? m[0] : path;
}

function firstStringArg(args: Record<string, unknown>): string | null {
  for (const v of Object.values(args)) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

export function extractMainArg(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  switch (toolName) {
    case 'web_search':
    case 'deep_research':
      return typeof args.query === 'string' ? truncate(args.query) : null;
    case 'read_url':
    case 'fetch_url':
    case 'read_webpage':
    case 'http_request': {
      if (typeof args.url !== 'string') return null;
      return truncate(args.url.replace(/^https?:\/\//, ''));
    }
    case 'read_file':
    case 'edit_file':
    case 'write_file':
      return typeof args.path === 'string' ? basename(args.path) : null;
    case 'shell_exec':
      return typeof args.command === 'string' ? truncate(args.command, 40) : null;
    case 'git_commit':
      return typeof args.message === 'string' ? truncate(args.message, 40) : null;
    case 'git_status':
    case 'git_diff':
    case 'git_log':
    case 'git_branch':
      return null;
    case 'read_skill':
      return typeof args.id === 'string'
        ? truncate(`Skill: ${args.id}`, 30)
        : null;
    case 'ask_user': {
      if (!Array.isArray(args.questions)) return null;
      const n = args.questions.length;
      return n === 1 ? '1 question' : `${n} questions`;
    }
    case 'calculator':
      return typeof args.expression === 'string' ? truncate(args.expression) : null;
    case 'file_search':
      return typeof args.pattern === 'string' ? truncate(args.pattern, 40) : null;
    case 'grep':
      return typeof args.pattern === 'string' ? truncate(args.pattern, 40) : null;
    case 'memory_ops':
      return typeof args.action === 'string' ? truncate(args.action, 20) : null;
    case 'todo_write': {
      const action = typeof args.action === 'string' ? args.action : 'list';
      if (action !== 'add' || !Array.isArray(args.items)) return truncate(action, 30);
      return truncate(`${action} ${args.items.length}`, 30);
    }
    case 'time_date':
      return typeof args.format === 'string' ? truncate(args.format, 20) : null;
    case 'tool_health':
    case 'scan_workspace':
      return null;
    case 'code-quality:run_tests':
    case 'code-quality:format_code':
    case 'code-quality:lint_code':
    case 'code-quality:build_project':
    case 'code-quality:install_deps':
      return null;
    default:
      return firstStringArg(args);
  }
}
