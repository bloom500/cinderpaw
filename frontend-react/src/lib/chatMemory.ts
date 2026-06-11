/**
 * Chat-tab memory — recall + learning for the direct inference path.
 *
 * The Feral Agent sidecar has its own memory stack (episodic/semantic/graph).
 * The Chat tab talks to the model directly (local llama.cpp or BYOK cloud)
 * and used to have NO memory at all: every conversation started cold and
 * nothing was ever learned. This module closes both gaps using the SAME
 * knowledge graph file the sidecar maintains (`~/.feral/memory-graph.json`):
 *
 *   - `buildMemoryContext()` reads the shared graph and renders a compact
 *     "[Memory context]" block appended to the system prompt of every send,
 *     so a brand-new chat opens already knowing the user.
 *
 *   - `extractChatMemory()` runs fire-and-forget after a turn completes:
 *     one cheap non-streaming completion extracts `subject | predicate |
 *     object` triples from the recent transcript and merges them into the
 *     graph via the `add_memory_facts` command. Failures are swallowed —
 *     memory is best-effort and must never break the chat.
 */

import { tauri, type Message, type MemoryFactInput, type InferParams } from '@/lib/tauri';
import type { CloudModel } from '@/stores/model';

/** Max graph facts injected into the system prompt per send. */
const MAX_CONTEXT_FACTS = 20;
/** How many recent messages feed one extraction pass. */
const EXTRACT_WINDOW = 6;
/** Per-message char cap inside the extraction transcript. */
const EXTRACT_SNIPPET_CHARS = 300;

/**
 * Per-session cache of the rendered memory block. The block MUST stay
 * byte-identical across all sends of one conversation: it sits inside the
 * system prompt (the very first tokens), and llama.cpp's KV-cache prefix
 * reuse compares prompts token-by-token from the start. Re-rendering it per
 * send (extraction bumps `touched_at` after every turn, reordering facts)
 * changed the prefix every time and forced a full re-prefill of the whole
 * conversation on local models.
 */
const sessionContextCache = new Map<string, string>();
const SESSION_CACHE_MAX = 50;

/**
 * Render the shared knowledge graph as a prompt block, newest facts first.
 * Returns '' when the graph is empty or unreadable. Cached per session:
 * the first send of a conversation snapshots the graph and later sends
 * reuse that exact block (see cache note above).
 */
export async function buildMemoryContext(sessionId: string): Promise<string> {
  const cached = sessionContextCache.get(sessionId);
  if (cached !== undefined) return cached;
  const context = await renderMemoryContext();
  if (sessionContextCache.size >= SESSION_CACHE_MAX) sessionContextCache.clear();
  sessionContextCache.set(sessionId, context);
  return context;
}

async function renderMemoryContext(): Promise<string> {
  try {
    const graph = await tauri.memory.getGraph();
    if (graph.edges.length === 0) return '';

    const touched = new Map(graph.nodes.map((n) => [n.id, n] as const));
    const lines = graph.edges
      .slice()
      .sort((a, b) => {
        const ta = Math.max(touched.get(a.from)?.touched_at ?? 0, touched.get(a.to)?.touched_at ?? 0);
        const tb = Math.max(touched.get(b.from)?.touched_at ?? 0, touched.get(b.to)?.touched_at ?? 0);
        return tb - ta;
      })
      .slice(0, MAX_CONTEXT_FACTS)
      .flatMap((e) => {
        const from = touched.get(e.from);
        const to = touched.get(e.to);
        return from && to ? [`- ${from.label} ${e.relation} ${to.label}`] : [];
      });

    if (lines.length === 0) return '';
    return [
      '[Memory context]',
      'Facts learned about the user in past conversations (use them naturally, do not recite them):',
      ...lines,
      '[End memory context]',
    ].join('\n');
  } catch {
    return '';
  }
}

const EXTRACTION_SYSTEM_PROMPT = [
  'You extract durable facts about the USER from a conversation transcript.',
  'Output ONE fact per line in exactly this format:',
  'subject | predicate | object',
  'Examples:',
  'user | name is | Darius',
  'user | works on | Feral desktop app',
  'user | prefers | concise answers',
  'Only include facts worth remembering across conversations (identity, role,',
  'preferences, ongoing projects, goals). No transient chit-chat.',
  'If there is nothing worth extracting, output exactly: NONE',
].join('\n');

/** Parse `subject | predicate | object` lines into fact triples. */
export function parseFactLines(raw: string): MemoryFactInput[] {
  const facts: MemoryFactInput[] = [];
  for (const line of raw.split('\n')) {
    const cleaned = line.replace(/^[-*\d.\s]+/, '').trim();
    if (!cleaned || /^NONE$/i.test(cleaned)) continue;
    const parts = cleaned.split('|').map((p) => p.trim());
    if (parts.length !== 3) continue;
    const [subject, predicate, object] = parts;
    if (!subject || !predicate || !object) continue;
    if (subject.length > 120 || predicate.length > 60 || object.length > 300) continue;
    facts.push({ subject, predicate, object });
  }
  return facts;
}

/**
 * Fire-and-forget learning pass for the chat tab. Runs one non-streaming
 * completion against whichever backend the chat itself used (cloud BYOK or
 * the local model) and merges the extracted triples into the shared graph.
 */
export async function extractChatMemory(
  messages: Message[],
  cloud: CloudModel | null,
): Promise<void> {
  try {
    // Same cadence as the sidecar's extractor: first assistant turn (short
    // chats still learn something), then every 3rd. Running an extra
    // completion after EVERY turn contended with the user's next message
    // for the local model — on modest hardware the chat felt busy exactly
    // when the user wanted to type again.
    const assistantTurns = messages.filter(
      (m) => m.role === 'assistant' && m.content.trim(),
    ).length;
    if (assistantTurns !== 1 && assistantTurns % 3 !== 0) return;

    const recent = messages
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim())
      .slice(-EXTRACT_WINDOW);
    if (recent.length < 2) return;

    const transcript = recent
      .map((m) => `${m.role}: ${m.content.slice(0, EXTRACT_SNIPPET_CHARS)}`)
      .join('\n');

    const params: InferParams = {
      temperature: 0.1,
      top_p: 0.9,
      repeat_penalty: 1.1,
      max_tokens: 250,
      system_prompt: EXTRACTION_SYSTEM_PROMPT,
      tools: null,
    };
    const extractionMessages: Message[] = [{ role: 'user', content: transcript }];

    const raw = cloud
      ? await tauri.raw.chatCloudComplete(cloud.providerId, cloud.modelId, extractionMessages, params)
      : await tauri.raw.chatCompleteLocal(extractionMessages, params);

    const facts = parseFactLines(raw);
    if (facts.length > 0) {
      await tauri.memory.addFacts(facts);
    }
  } catch (err) {
    // Best-effort: memory extraction must never surface as a chat error.
    console.warn('[chatMemory] extraction skipped:', err);
  }
}
