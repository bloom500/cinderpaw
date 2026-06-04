import { useCallback } from 'react';
import { useChat, type ChatMessage } from '@/stores/chat';
import { useConversations } from '@/stores/conversations';
import { useModel } from '@/stores/model';
import { useUI } from '@/stores/ui';
import { useAgent } from '@/stores/agent';
import { useChatStream } from './useChatStream';
import { useFeralStream } from './useFeral';
import { toIpcMessage } from '@/lib/messageMapping';
import { currentInferParams } from '@/lib/inferParams';
import { autoTitle } from '@/lib/autoTitle';
import { splitThinking } from '@/lib/parseThink';
import type { AttachedFile } from '@/components/chat/AttachedFileChip';

function buildUserContent(text: string, files: AttachedFile[]): string {
  const validFiles = files.filter((f) => f.content !== null);
  if (validFiles.length === 0) return text;
  const fileBlocks = validFiles
    .map((f) => `[File: ${f.name}]\n${f.content}`)
    .join('\n\n');
  return `${fileBlocks}\n\n${text}`;
}

function autoSaveIfEligible() {
  const chat = useChat.getState();
  const hasUser      = chat.messages.some((m) => m.role === 'user');
  const hasCompleteA = chat.messages.some((m) => m.role === 'assistant' && m.content.trim().length > 0);
  if (chat.streamStatus !== 'done' || !hasUser || !hasCompleteA) return;
  void useConversations.getState().saveCurrent(autoTitle(chat.messages));
}

export function useSendMessage() {
  const stream      = useChatStream(useChat.getState().sessionId);
  const feralStream = useFeralStream(useChat.getState().sessionId);

  return useCallback(
    async (text: string, files: AttachedFile[] = []) => {
      const chat = useChat.getState();
      const { reasoningMode, enabledTools } = useUI.getState();
      const { loaded, cloudModel } = useModel.getState();
      const modelName = cloudModel?.modelId ?? loaded?.name ?? '';

      const content = buildUserContent(text, files);

      const userMsg = {
        id: crypto.randomUUID(),
        role: 'user' as const,
        content,
        createdAt: Date.now(),
      };
      const asstMsg = {
        id: crypto.randomUUID(),
        role: 'assistant' as const,
        content: '',
        thinkingComplete: true,
        createdAt: Date.now() + 1,
      };
      chat.addMessage(userMsg);
      chat.addMessage(asstMsg);
      chat.setStreamStatus('streaming');

      const messages = useChat.getState().messages.slice(0, -1).map(toIpcMessage);

      // Agent mode override: when an active agent exists, its
      // system_prompt and tool list are authoritative. This lets the
      // same hook serve both Chat (user-controlled) and Agents
      // (agent-controlled) without two parallel code paths.
      const agent = useAgent.getState().current;
      const effectiveEnabledTools = agent ? agent.tools : enabledTools;
      const effectiveSystemPrompt = agent ? agent.system_prompt : undefined;

      const params = await currentInferParams({
        reasoningMode,
        modelName,
        enabledTools: effectiveEnabledTools,
        systemPromptOverride: effectiveSystemPrompt,
      });

      let buffer = '';
      let thinkingStartAt: number | null = null;
      let thinkingDurationMsFixed = false;
      let streamStartAt: number | null = null;
      let charCount = 0;

      // RAF-based flushing: accumulate token patches between frames so React
      // re-renders once per animation frame (~60fps) instead of once per token.
      // This produces smooth word-by-word streaming without overwhelming the renderer.
      let rafId: number | null = null;
      const pendingPatch: Partial<ChatMessage> = {};

      const flushNow = () => {
        if (Object.keys(pendingPatch).length > 0) {
          useChat.getState().updateLastAssistantMessage({ ...pendingPatch });
        }
        rafId = null;
      };

      const scheduleFlush = () => {
        if (rafId === null) {
          rafId = requestAnimationFrame(flushNow);
        }
      };

      const cancelFlush = () => {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
      };

      // Route: cloud → cloudModel stream; local model → llama.cpp stream;
      // neither → Feral Agent sidecar (Ollama-backed, with sandbox + memory).
      const useFeral = !cloudModel && !loaded;

      if (useFeral) {
        await feralStream.send(content, {
          onToken:   (chunk) => { chat.appendToStreamingAssistant(chunk); },
          onDone:    () => { chat.setStreamStatus('done'); autoSaveIfEligible(); },
          onError:   (err) => { chat.setStreamStatus('error', err); },
          onStopped: () => { chat.setStreamStatus('stopped'); },
        });
        return;
      }

      const streamMethod = cloudModel
        ? (cb: Parameters<typeof stream.start>[2]) => stream.startCloud(cloudModel, messages, params, cb)
        : (cb: Parameters<typeof stream.start>[2]) => stream.start(messages, params, cb);

      await streamMethod({
        onToken: (chunk) => {
          if (streamStartAt === null) streamStartAt = Date.now();
          charCount += chunk.length;
          buffer += chunk;
          const split = splitThinking(buffer);

          pendingPatch.content = split.answer;

          if (split.thinking !== null) {
            pendingPatch.thinking = split.thinking;
            pendingPatch.thinkingComplete = split.thinkingComplete;
            if (thinkingStartAt === null) thinkingStartAt = Date.now();
            if (split.thinkingComplete && !thinkingDurationMsFixed && thinkingStartAt !== null) {
              pendingPatch.thinkingDurationMs = Date.now() - thinkingStartAt;
              thinkingDurationMsFixed = true;
            }
          }

          scheduleFlush();
        },
        onDone: () => {
          // Flush any remaining buffered patch before computing final stats
          cancelFlush();
          flushNow();

          const completedAt = Date.now();
          const elapsedSec = streamStartAt ? (completedAt - streamStartAt) / 1000 : 0;
          const tokenCount = Math.round(charCount / 4);
          const tokensPerSec = elapsedSec > 0 ? Math.round(tokenCount / elapsedSec) : 0;
          useChat.getState().updateLastAssistantMessage({ completedAt, tokenCount, tokensPerSec });
          useChat.getState().setStreamStatus('done');
          autoSaveIfEligible();
        },
        onError: (err) => {
          cancelFlush();
          useChat.getState().setStreamStatus('error', err);
        },
        onStopped: () => {
          cancelFlush();
          useChat.getState().setStreamStatus('stopped');
        },
      });
    },
    [stream],
  );
}
