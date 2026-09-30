/**
 * The app's side of the campfire game's message contract; the game's side is
 * games/ember/scripts/bridge.gd. Messages cross as JSON strings through
 * postMessage, addressed to this window's own origin.
 */
export type SparkKind = 'search' | 'read' | 'build' | 'other';

export type ToGame =
  | { type: 'start'; best: number }
  | { type: 'spark'; kind: SparkKind }
  | { type: 'end'; ok: boolean }
  | { type: 'pause' }
  | { type: 'resume' };

export type FromGame = { type: 'ready' } | { type: 'score'; value: number } | { type: 'close' };

// Grouped from the tools in mascot/emojiForTool.ts. A tool not listed is 'other':
// it still throws sparks, in the plain orange.
const SEARCH = new Set(['web_search', 'deep_research', 'read_url', 'read_webpage', 'fetch_url', 'http_request']);
const READ = new Set(['read_file', 'file_search', 'grep', 'read_skill', 'scan_workspace', 'git_status', 'git_diff', 'git_log']);
const BUILD = new Set(['edit_file', 'write_file', 'shell_exec', 'git_commit', 'git_branch']);

export function sparkKindForTool(name: string): SparkKind {
  if (SEARCH.has(name)) return 'search';
  if (READ.has(name)) return 'read';
  if (BUILD.has(name) || name.startsWith('code-quality:')) return 'build';
  return 'other';
}

export const encode = (m: ToGame): string => JSON.stringify(m);

export function decode(data: unknown): FromGame | null {
  if (typeof data !== 'string') return null;
  let m: unknown;
  try {
    m = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof m !== 'object' || m === null) return null;
  const { type, value } = m as { type?: unknown; value?: unknown };
  if (type === 'ready' || type === 'close') return { type };
  if (type === 'score' && typeof value === 'number' && Number.isFinite(value)) {
    return { type: 'score', value: Math.max(0, Math.round(value)) };
  }
  return null;
}
