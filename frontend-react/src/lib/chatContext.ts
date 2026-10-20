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
  /** Every tool this chat's replies ran, first use first. Read from the saved
   *  steps: the live strip it came from before is wiped 5 s after a reply, so
   *  "Tools in use" emptied the moment a reply ended (UX lab, item 19). */
  tools: string[];
}

export function chatContext(messages: readonly ChatMessage[]): ChatContext {
  const files: DisplayAttachment[] = [];
  const fileKeys = new Set<string>();
  const sources: ToolHit[] = [];
  const sourceKeys = new Set<string>();
  const memories: MemoryUsedItem[] = [];
  const memoryKeys = new Set<string>();
  const artifactIds: string[] = [];
  const tools: string[] = [];

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
      if (!tools.includes(a.tool)) tools.push(a.tool);
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
  return { files, sources, memories, artifactIds, tools };
}

function mergeContext(earlier: ChatContext, later: ChatContext): ChatContext {
  const unique = <T,>(items: T[], key: (item: T) => string): T[] => {
    const seen = new Set<string>();
    return items.filter((item) => {
      const id = key(item);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  };
  return {
    files: unique([...earlier.files, ...later.files], (f) => `${f.kind}:${f.name}`),
    sources: unique([...earlier.sources, ...later.sources], (s) => normalizeUrl(s.url) ?? s.url),
    memories: unique([...earlier.memories, ...later.memories], (m) => m.text),
    artifactIds: unique([...later.artifactIds, ...earlier.artifactIds], (id) => id),
    tools: unique([...earlier.tools, ...later.tools], (tool) => tool),
  };
}

/**
 * Chat messages are immutable. Keep the settled prefix's context and parse
 * only the changing tail. Editing history or switching chats rebuilds it.
 * Checking object identities is cheap; parsing every old body on each token
 * was not. This retains one prefix, not a snapshot for every message.
 */
export function createChatContextReader(): (messages: readonly ChatMessage[]) => ChatContext {
  let previous: readonly ChatMessage[] = [];
  let count = 0;
  let prefix = chatContext([]);
  return (messages) => {
    const nextCount = Math.max(0, messages.length - 1);
    let same = count <= nextCount;
    for (let i = 0; same && i < count; i++) same = previous[i] === messages[i];
    if (!same) {
      count = 0;
      prefix = chatContext([]);
    }
    if (nextCount > count) prefix = mergeContext(prefix, chatContext(messages.slice(count, nextCount)));
    count = nextCount;
    previous = messages;
    return mergeContext(prefix, chatContext(messages.slice(count)));
  };
}
