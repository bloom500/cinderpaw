import type { ToolHit } from '@/hooks/useLiveToolActivity';
import type { ChatMessage, MemoryUsedItem } from '@/stores/chat';
import { parseUserAttachments, type DisplayAttachment } from '@/lib/attachmentDisplay';
import { citedSources, normalizeUrl, sourcesOf } from '@/lib/sources';

/** Tools that open one page, whose `subject` is its address. */
const PAGE_TOOLS = new Set(['read_webpage', 'fetch_url']);

/**
 * What this chat has put in front of Cinderpaw, for the Context tab (spec 7.5).
 * Read from the messages only, never guessed: the files the person attached,
 * the pages the replies cited or the agent opened, the memories given to a
 * turn (Memory Peek's two sources), and the artifacts its tools made.
 */
export interface ChatContext {
  files: DisplayAttachment[];
  sources: ToolHit[];
  memories: MemoryUsedItem[];
  /** Newest first. */
  artifactIds: string[];
}

export function chatContext(messages: readonly ChatMessage[]): ChatContext {
  const files: DisplayAttachment[] = [];
  const fileKeys = new Set<string>();
  const sources: ToolHit[] = [];
  const sourceKeys = new Set<string>();
  const memories: MemoryUsedItem[] = [];
  const memoryKeys = new Set<string>();
  const artifactIds: string[] = [];

  const addSource = (hit: ToolHit) => {
    const key = normalizeUrl(hit.url);
    if (key && !sourceKeys.has(key)) { sourceKeys.add(key); sources.push(hit); }
  };
  const addMemory = (m: MemoryUsedItem) => {
    if (!memoryKeys.has(m.text)) { memoryKeys.add(m.text); memories.push(m); }
  };

  for (const m of messages) {
    if (m.role === 'user') {
      for (const f of parseUserAttachments(m.content).attachments) {
        const key = `${f.kind}:${f.name}`;
        if (!fileKeys.has(key)) { fileKeys.add(key); files.push(f); }
      }
      continue;
    }
    const activity = m.toolActivity ?? [];
    for (const hit of citedSources(m.content, sourcesOf(activity))) addSource(hit);
    for (const a of activity) {
      if (a.status !== 'done') continue;
      if (PAGE_TOOLS.has(a.tool) && normalizeUrl(a.subject)) {
        const host = (() => { try { return new URL(a.subject).hostname; } catch { return ''; } })();
        addSource({ title: '', url: a.subject, host, snippet: '', crumbs: '' });
      }
      if (a.kind === 'memory') for (const text of a.facts) addMemory({ kind: 'fact', text });
      if (a.artifact) {
        // An artifact changed again later moves back to the front.
        const at = artifactIds.indexOf(a.artifact.id);
        if (at >= 0) artifactIds.splice(at, 1);
        artifactIds.unshift(a.artifact.id);
      }
    }
    for (const u of m.memoryUsed ?? []) addMemory(u);
  }
  return { files, sources, memories, artifactIds };
}
