import type { ToolCallEvent } from '@/stores/chat';
import { sparkKindForTool, type SparkKind } from './emberBridge';

/** The sparks owed for tool calls not thrown yet: tool entries only, each id
 *  once, and only calls that started after `since` (when the panel opened). */
export function takeNewSparks(stream: readonly ToolCallEvent[], seen: Set<string>, since: number): SparkKind[] {
  const out: SparkKind[] = [];
  for (const e of stream) {
    if (e.kind !== 'tool' || seen.has(e.id) || e.startedAt < since) continue;
    seen.add(e.id);
    out.push(sparkKindForTool(e.name));
  }
  return out;
}
