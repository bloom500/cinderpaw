import type { MascotState } from './frames';

/**
 * Agent Pulse: the word beside the composer mascot that says what the turn is
 * doing (spec 7.5). One of six, or nothing.
 */
export type PulseLabel =
  | 'Thinking' | 'Searching' | 'Using memory' | 'Running tool' | 'Waiting for approval' | 'Done';

/** The sidecar's search tools (`web_search`, `deep_research`, `file_search`). */
const SEARCH_TOOL = /^(web_search|deep_research|file_search)/;
/** The sidecar's memory tools (`recall`, `remember`, `self_memory`). */
const MEMORY_TOOL = /^(recall|remember|self_memory)/;

/**
 * The label for what the mascot is showing.
 *
 * `tool` is the running tool's name (`agentTool` in the chat store), which is
 * what tells a search apart from any other call. `approvalPending` outranks the
 * rest: a turn that is waiting on the person is not thinking, whatever the
 * creature's pose says.
 *
 * Idle, typing, asleep and the error beat say nothing: there is no turn to
 * describe, and the error has its own notice in the transcript.
 */
export function pulseLabel(
  state: MascotState,
  tool: string | null,
  approvalPending: boolean,
): PulseLabel | null {
  if (approvalPending) return 'Waiting for approval';
  switch (state) {
    case 'thinking':
      return 'Thinking';
    case 'searching':
      return 'Searching';
    case 'calling':
    case 'reading':
    case 'building':
      if (tool && SEARCH_TOOL.test(tool)) return 'Searching';
      if (tool && MEMORY_TOOL.test(tool)) return 'Using memory';
      return 'Running tool';
    case 'done':
    case 'celebrate':
      return 'Done';
    default:
      return null;
  }
}
