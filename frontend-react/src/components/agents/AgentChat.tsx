import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAgent } from '@/stores/agent';
import { useChat } from '@/stores/chat';
import { useConversations } from '@/stores/conversations';
import { AgentHeader } from './AgentHeader';
import { MessageList } from '@/components/chat/MessageList';
import { ChatInput, type ChatInputHandle } from '@/components/chat/ChatInput';
import { useFeralSendMessage } from '@/hooks/useFeral';
import { NewChatEmptyState } from '@/components/chat/EmptyStates';
import { ONBOARDING_KEY } from './agentUtils';
import { Bot } from 'lucide-react';

export function AgentChat() {
  const navigate     = useNavigate();
  const current      = useAgent((s) => s.current);
  const messages     = useChat((s) => s.messages);
  const sessionId    = useChat((s) => s.sessionId);
  const newSession   = useChat((s) => s.newSession);
  const loadingConversation = useConversations((s) => s.loadingConversation);

  // Feral Agent is always the inference backend for the Agents tab.
  // No model check needed — the sidecar provides its own Ollama inference.
  const feralSend = useFeralSendMessage(sessionId);
  const isEmpty   = messages.length === 0;

  const containerRef    = useRef<HTMLDivElement>(null);
  const inputWrapperRef = useRef<HTMLDivElement>(null);
  const chatInputRef    = useRef<ChatInputHandle>(null);
  const [translateY, setTranslateY] = useState(0);

  // NOTE: we don't call refresh() here. AgentGate is the single owner of
  // the hydration lifecycle — re-running refresh from AgentChat caused
  // an infinite re-fetch loop (zombie get_agents invocations).
  //
  // Reset the chat session whenever the active agent changes — an agent
  // owns its own system_prompt + tools, so a session started under one
  // agent would not make sense to continue under another. We depend on
  // the agent id (a stable string), not the agent object (whose
  // reference changes on every store update).
  useEffect(() => {
    if (!current?.id) return;
    newSession();
  }, [current?.id, newSession]);

  // Re-centre the empty-state greeting whenever the agent changes.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const wrapper   = inputWrapperRef.current;
    if (!container || !wrapper) return;
    if (isEmpty) {
      const containerH = container.offsetHeight;
      const inputH     = wrapper.offsetHeight;
      setTranslateY(-(containerH / 2 - inputH / 2));
    } else {
      setTranslateY(0);
    }
  }, [isEmpty, current?.id]);

  const handleSuggestion = (text: string) => {
    chatInputRef.current?.setText(text);
  };

  const handleReOnboard = () => {
    localStorage.removeItem(ONBOARDING_KEY);
    navigate('/agents', { replace: true });
    // Force a re-mount of the gate by triggering a state nudge on the agent
    // store. Clearing current is the simplest signal — the gate above will
    // then fall through to AgentsOnboarding because `current` is null.
    useAgent.getState().clear();
  };

  return (
    <div className="flex flex-col h-full">
      <AgentHeader />

      <div ref={containerRef} className="relative flex-1 overflow-hidden">
        {loadingConversation && (
          <div className="absolute inset-x-0 top-0 h-0.5 bg-brand animate-pulse z-10" />
        )}

        {messages.length > 0 ? (
          <MessageList />
        ) : current ? (
          <NewChatEmptyState isEmpty={isEmpty} onSuggestion={handleSuggestion} />
        ) : null}

        {current && (
          <div
            ref={inputWrapperRef}
            style={{
              transform: `translateY(${translateY}px)`,
              transition: 'transform 350ms cubic-bezier(0.4, 0, 0.2, 1)',
            }}
            className="absolute inset-x-0 bottom-0 z-20 pt-8 bg-gradient-to-t from-bg-primary via-bg-primary/95 to-transparent"
          >
            <ChatInput
              ref={chatInputRef}
              isEmpty={isEmpty}
              sendFn={feralSend}
              alwaysEnabled
            />
          </div>
        )}

        {/* No-agent hint: extremely rare path (agent deleted from Settings
            while the Agents tab was open). The gate above would normally
            catch this, but we keep a visible affordance in case a race
            leaves `current` null for a moment. */}
        {!current && (
          <div className="h-full flex flex-col items-center justify-center px-6 text-center">
            <Bot size={28} className="text-text-muted mb-3" />
            <h2 className="text-lg font-medium text-text-secondary mb-1">No agent selected</h2>
            <p className="text-sm text-text-muted mb-4 max-w-sm">
              Create an agent to give your assistant a personality, tools, and a goal.
            </p>
            <button
              type="button"
              onClick={handleReOnboard}
              className="px-4 py-2 rounded-md bg-brand text-white text-sm font-medium hover:bg-brand/90 transition-colors"
            >
              Create agent
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
