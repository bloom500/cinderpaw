import { invoke } from '@tauri-apps/api/core';
import { extractMainArg } from '@/components/chat/mascot/extractMainArg';
import { emojiForTool } from '@/components/chat/mascot/emojiForTool';
import { finishActivity, startActivity } from '@/hooks/useLiveToolActivity';
import { isLocalBaseUrl } from '@/lib/contextWindow';
import { splitThinking, stripStreamingToolCalls } from '@/lib/parseThink';
import type { CinderpawAgentEvent } from '@/lib/tauri';
import { createChatStore, type ChatMessage } from './chat';
import { useCinderpawStore } from './cinderpaw';
import { useCoworkTranscript, type CoworkExchange } from './coworkTranscript';
import { useModel } from './model';

interface Turn {
  buffer: string;
  committed: string;
  reply: Partial<ChatMessage>;
  toolCallIds: string[];
}

interface Chat {
  store: ReturnType<typeof createChatStore>;
  turns: Map<string, Turn>;
  voice: Map<string, ChatMessage['voice']>;
}

const chats = new Map<string, Chat>();
const awaitingQueue = new Map<string, (error?: Error) => void>();

function messagesFor(exchange: CoworkExchange, agentId: string, chat: Chat, forwardedRows: Set<string>): ChatMessage[] {
  const incoming = exchange.toAgentId === agentId;
  const messages: ChatMessage[] = [];
  const live = chat.turns.get(exchange.id)?.reply;
  const forwarded = !incoming && forwardedRows.has(exchange.id);
  if (exchange.requestText && !forwarded) messages.push({
    id: `${exchange.id}:req`, role: incoming ? 'user' : 'assistant', content: exchange.requestText, createdAt: exchange.at,
    images: exchange.requestImages, voice: exchange.voice ?? (exchange.desktopId ? chat.voice.get(exchange.desktopId) : undefined),
    coworkRequestId: incoming && exchange.fromAgentId === 'human' && exchange.threadId === `cowork:${agentId}` ? exchange.id : undefined,
  });
  // A forwarded mailbox row serves as the next prompt. At the hop cap there
  // is no such row and the answer must stay on its original exchange.
  if (incoming && (exchange.responseText || live || exchange.startedAt !== undefined || exchange.receipt?.stopped)) messages.push({
    ...live, id: `${exchange.id}:res`, role: 'assistant', createdAt: exchange.responseAt ?? exchange.at + 1,
    tokenCount: live?.tokenCount ?? exchange.receipt?.tokens,
    contextLanes: live?.contextLanes ?? exchange.receipt?.contextLanes,
    memoryUsed: live?.memoryUsed ?? exchange.receipt?.memoryUsed,
    coworkRequestId: exchange.fromAgentId === 'human' && exchange.threadId === `cowork:${agentId}` ? exchange.id : undefined,
    thinking: live?.thinking ?? exchange.receipt?.thinking,
    thinkingComplete: live?.thinkingComplete ?? exchange.status !== 'running',
    toolActivity: live?.toolActivity ?? exchange.receipt?.tools.map((t, i) => ({
      ...startActivity(t.name, undefined), status: t.done && !t.failed ? 'done' : 'failed',
      id: `${exchange.id}:tool:${i}`, startedAt: t.startedAt ?? exchange.startedAt ?? exchange.at,
      endedAt: t.endedAt ?? exchange.responseAt ?? null,
    })),
    content: exchange.status !== 'running' ? (live?.content || exchange.responseText || '') : live?.content ?? '',
    ended: live?.ended ?? (exchange.receipt?.stopped ? { kind: 'stopped' } : exchange.status === 'error' ? { kind: 'error', raw: exchange.responseText ?? 'The turn failed.' } : undefined),
  });
  return messages;
}

function syncChat(sessionId: string, chat: Chat, exchanges: CoworkExchange[]) {
  const id = sessionId.slice('cowork:'.length);
  const relevant = exchanges.filter((e) => e.kind !== 'approval' && (e.toAgentId === id || e.fromAgentId === id));
  const active = relevant.findLast((e) => e.toAgentId === id && e.status === 'running' && e.startedAt !== undefined);
  const forwardedRows = new Set(relevant.flatMap((e) => e.receipt?.forwardedId ? [`msg:${e.receipt.forwardedId}`] : []));
  const messages = relevant.flatMap((e) => messagesFor(e, id, chat, forwardedRows)).sort((a, b) => a.createdAt - b.createdAt);
  if (active) {
    const index = messages.findIndex((m) => m.id === `${active.id}:res`);
    if (index >= 0) messages.push(...messages.splice(index, 1));
  }
  const state = chat.store.getState();
  chat.store.setState({ messages: [...messages, ...state.messages.filter((m) => m.voicePending)] });
  if (active && state.streamStatus !== 'streaming') state.setStreamStatus('streaming');
  if (!active && state.streamStatus === 'streaming') state.setStreamStatus('done');
}

export function getCoworkChat(sessionId: string): Chat {
  const existing = chats.get(sessionId);
  if (existing) return existing;
  const chat: Chat = { store: createChatStore(), turns: new Map(), voice: new Map() };
  chat.store.setState({ sessionId });
  chats.set(sessionId, chat);
  syncChat(sessionId, chat, useCoworkTranscript.getState().exchanges);
  return chat;
}

useCoworkTranscript.subscribe((state, previous) => {
  if (state.exchanges === previous.exchanges) return;
  for (const [sessionId, chat] of chats) syncChat(sessionId, chat, state.exchanges);
});

type ScopedEvent = CinderpawAgentEvent & { sessionId?: string; coworkExchangeId?: string };

export function ingestCoworkChat(event: ScopedEvent) {
  if (event.type === 'cowork_event' && event.eventType === 'message_queued' && typeof event.data?.desktopId === 'string') {
    awaitingQueue.get(event.data.desktopId)?.();
  } else if (event.type === 'error' && event.id) {
    awaitingQueue.get(event.id)?.(new Error(event.message));
  }
  const sessionId = event.sessionId;
  const exchangeId = event.coworkExchangeId;
  if (!sessionId?.startsWith('cowork:') || !exchangeId) return;
  const chat = getCoworkChat(sessionId);
  const turn: Turn = chat.turns.get(exchangeId) ?? { buffer: '', committed: '', reply: {}, toolCallIds: [] };
  chat.turns.set(exchangeId, turn);
  const state = chat.store.getState();
  const tools = turn.reply.toolActivity ?? [];
  const now = Date.now();
  switch (event.type) {
    case 'chunk': {
      turn.buffer += event.content;
      const part = splitThinking(turn.buffer);
      const answer = stripStreamingToolCalls(part.answer);
      turn.reply.content = [turn.committed, answer].filter(Boolean).join('\n\n');
      if (part.thinking !== null) {
        turn.reply.thinking = part.thinking;
        turn.reply.thinkingComplete = part.thinkingComplete;
      }
      turn.reply.agentMessageId = event.id;
      state.setAgentPhase('thinking');
      break;
    }
    case 'tool_start': {
      turn.committed = turn.reply.content ?? '';
      turn.buffer = '';
      turn.reply.toolActivity = [...tools, { ...startActivity(event.tool, event.args), at: turn.committed.length }];
      turn.toolCallIds.push(state.pushToolCall({ kind: 'tool', name: event.tool, emoji: emojiForTool(event.tool),
        mainArg: extractMainArg(event.tool, event.args ?? {}), status: 'running', startedAt: now }));
      state.setAgentPhase('calling', event.tool);
      break;
    }
    case 'tool_done': {
      const index = tools.findLastIndex((tool) => tool.tool === event.tool && tool.status === 'running');
      if (index >= 0) {
        turn.reply.toolActivity = tools.map((tool, i) => i === index ? finishActivity(tool, event.result) : tool);
        const finished = turn.reply.toolActivity[index]!;
        state.completeToolCall(turn.toolCallIds[index]!, {
          ok: finished.status === 'done', error: finished.error ?? undefined, preview: finished.output.slice(0, 500),
        });
        const data = (event.result as { data?: { scratch?: boolean; linesAdded?: number; linesRemoved?: number } } | null)?.data;
        if (finished.status === 'done' && data?.scratch) {
          const previous = turn.reply.scratch ?? { edits: 0, added: 0, removed: 0 };
          turn.reply.scratch = { edits: previous.edits + 1,
            added: previous.added + (typeof data.linesAdded === 'number' ? data.linesAdded : 0),
            removed: previous.removed + (typeof data.linesRemoved === 'number' ? data.linesRemoved : 0) };
        }
      }
      state.setAgentPhase('processing');
      break;
    }
    case 'tool_progress': {
      state.noteToolProgress(event.message);
      const index = tools.findLastIndex((tool) => tool.tool === event.tool && tool.status === 'running');
      if (index >= 0) turn.reply.toolActivity = tools.map((tool, i) => i === index ? { ...tool, note: event.message } : tool);
      break;
    }
    case 'usage':
      state.setLiveTokens(event.promptTokens, event.completionTokens);
      turn.reply.contextLanes = event.lanes;
      turn.reply.tokenCount = event.completionTokens;
      break;
    case 'memory_used':
      turn.reply.memoryUsed = event.items;
      break;
    case 'steer_applied':
      turn.reply.steered = [...(turn.reply.steered ?? []), ...event.texts.map((text) => ({ text, at: turn.reply.content?.length ?? 0, afterTools: tools.length }))];
      break;
    case 'done':
      turn.reply.agentMessageId = event.id;
      if (!turn.reply.content?.trim()) turn.reply.content = stripStreamingToolCalls(splitThinking(event.content).answer);
      turn.reply.completedAt = now;
      turn.reply.thinkingComplete = true;
      if (event.stopped) turn.reply.ended = { kind: 'stopped' };
      if (event.diagnostic) turn.reply.content = [turn.reply.content, `_${event.diagnostic}_`].filter(Boolean).join('\n\n');
      break;
    case 'error':
      turn.reply.ended = { kind: 'error', raw: event.message };
      break;
    default:
      return;
  }
  syncChat(sessionId, chat, useCoworkTranscript.getState().exchanges);
}

export async function sendCoworkChat(sessionId: string, content: string, images?: string[], options?: {
  voice?: ChatMessage['voice']; existingUserId?: string; surface?: 'voice' | 'text'; replaceFrom?: string;
}) {
  const chat = getCoworkChat(sessionId);
  const { inferParams: { temperature }, effort } = useModel.getState();
  const local = isLocalBaseUrl(useCinderpawStore.getState().modelConfig?.base_url);
  const requestId = crypto.randomUUID();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queued = new Promise<void>((resolve, reject) => {
    awaitingQueue.set(requestId, (err) => err ? reject(err) : resolve());
    timer = setTimeout(() => reject(new Error('The teammate did not confirm receipt. Check the chat before retrying.')), 15000);
  });
  const [messageId] = await Promise.all([invoke<string>('cinderpaw_send_message', {
    requestId,
    content, sessionId, images: images?.length ? images : null, inferParams: local ? { temperature } : { effort },
    surface: options?.surface ?? 'text',
    ...(options?.replaceFrom ? { replaceFrom: options.replaceFrom } : {}),
    ...(options?.voice ? { voice: options.voice } : {}),
  }), queued]).finally(() => { clearTimeout(timer); awaitingQueue.delete(requestId); });
  if (options?.voice) chat.voice.set(messageId, options.voice);
  if (options?.existingUserId) chat.store.getState().removeMessage(options.existingUserId);
  if (options?.voice) syncChat(sessionId, chat, useCoworkTranscript.getState().exchanges);
  return messageId;
}
