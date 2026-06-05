import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useChat } from '@/stores/chat';
import { useConversations } from '@/stores/conversations';
import { useModel } from '@/stores/model';
import { useProjects } from '@/stores/projects';
import { useUI } from '@/stores/ui';
import { useAgent } from '@/stores/agent';
import { ChatHeader } from '@/components/chat/ChatHeader';
import { MessageList } from '@/components/chat/MessageList';
import { ChatInput, type ChatInputHandle } from '@/components/chat/ChatInput';
import { NoModelEmptyState, NewChatEmptyState } from '@/components/chat/EmptyStates';
import { FeralGlobalMount } from '@/components/chat/FeralGlobalMount';
import { useFeralSendMessage } from '@/hooks/useFeral';
import { useFeralStore } from '@/stores/feral';

export function ChatPage() {
  const { id } = useParams();
  const loaded      = useModel((s) => s.loaded);
  const cloudModel  = useModel((s) => s.cloudModel);
  const messages    = useChat((s) => s.messages);
  const loadingConversation = useConversations((s) => s.loadingConversation);

  const inputMode    = useUI((s) => s.inputMode);
  const setInputMode = useUI((s) => s.setInputMode);
  const sessionId    = useChat((s) => s.sessionId);
  const feralSend    = useFeralSendMessage(sessionId);
  const isAgentMode  = inputMode === 'agent';

  const hasModel  = !!loaded || !!cloudModel;
  const canInput  = hasModel || isAgentMode;
  const isEmpty   = messages.length === 0 && canInput;

  const containerRef    = useRef<HTMLDivElement>(null);
  const inputWrapperRef = useRef<HTMLDivElement>(null);
  const chatInputRef    = useRef<ChatInputHandle>(null);
  const [translateY, setTranslateY] = useState(0);

  // Recompute centering offset whenever isEmpty changes
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
  }, [isEmpty]);

  // Initial data hydration
  useEffect(() => {
    void useConversations.getState().refresh();
    void useProjects.getState().refresh();
    void useModel.getState().refresh();
  }, []);

  // Open conversation when route changes; auto-switch to agent mode
  // if the conversation was created under a Feral Agent.
  useEffect(() => {
    if (!id) return;
    const targetId = id;
    // Arm reopen flag SYNCHRONOUSLY before any await so effects that
    // fire immediately see it set.
    useAgent.getState().setReopenSessionId(targetId);
    void (async () => {
      await useConversations.getState().open(targetId);
      // Guard: bail if navigation moved on before this await resolved.
      if (useAgent.getState().reopenSessionId !== targetId) return;
      const meta = useConversations.getState().list.find((c) => c.id === targetId);
      if (!meta?.agent_id) {
        useAgent.getState().setReopenSessionId(null);
        return;
      }
      setInputMode('agent');
      await useAgent.getState().refresh();
      // Guard again after second await.
      if (useAgent.getState().reopenSessionId !== targetId) return;
      const agent = useAgent.getState().list.find((a) => a.id === meta.agent_id);
      if (agent?.id) useAgent.getState().setCurrent(agent.id);
    })();
    return () => {
      useAgent.getState().setReopenSessionId(null);
    };
  }, [id, setInputMode]);

  // Clear the reopen flag once the target conversation is active.
  const reopenSessionId = useAgent((s) => s.reopenSessionId);
  useEffect(() => {
    if (reopenSessionId && useChat.getState().sessionId === reopenSessionId) {
      useAgent.getState().setReopenSessionId(null);
    }
  }, [reopenSessionId, sessionId]);

  // When the user switches to agent mode:
  // 1. Ensure an agent is selected so feralSend can tag conversations.
  // 2. Hot-swap the Feral sidecar to the currently loaded local model.
  //    The sidecar persists its own model config and may be pointing at
  //    an Ollama model name that doesn't match what's loaded in the
  //    Feral inference backend (port 11435). Without this sync, all
  //    sidecar requests fail silently.
  useEffect(() => {
    if (inputMode !== 'agent') return;

    if (!useAgent.getState().current) {
      void useAgent.getState().refresh().then(() => {
        const first = useAgent.getState().list[0];
        if (first?.id) useAgent.getState().setCurrent(first.id);
      });
    }

    // Sync the sidecar to the loaded local model — BUT never clobber an
    // explicit cloud/BYOK choice. A BYOK selection sets modelConfig.provider to
    // the provider id (e.g. "openai"); local uses "openai_compatible" and
    // external Ollama uses "ollama". If the user already picked a cloud model
    // via FeralModelSelector, leave it; only auto-sync when on a local target.
    if (loaded) {
      const cfg = useFeralStore.getState().modelConfig;
      const onCloud = !!cfg && cfg.provider !== 'openai_compatible' && cfg.provider !== 'ollama';
      if (!onCloud) {
        void useFeralStore.getState().setModel({
          source: 'openai_compatible',
          model: loaded.name,
          baseUrl: 'http://localhost:11435',
          providerId: 'feral-local',
        }).catch(console.error);
      }
    }
  }, [inputMode, loaded]);

  // Listen for Ctrl+N / ⌘N from useGlobalHotkeys
  useEffect(() => {
    const handler = () => useConversations.getState().newChat();
    window.addEventListener('feral:new-chat', handler);
    return () => window.removeEventListener('feral:new-chat', handler);
  }, []);

  const handleSuggestion = (text: string) => {
    chatInputRef.current?.setText(text);
  };

  return (
    <div className="flex flex-col h-full">
      <ChatHeader />

      {isAgentMode && <FeralGlobalMount />}

      {/* Positioning context for absolute children */}
      <div ref={containerRef} className="relative flex-1 overflow-hidden">
        {loadingConversation && (
          <div className="absolute inset-x-0 top-0 h-0.5 bg-brand animate-pulse z-10" />
        )}

        {/* Content: messages, no-model state, or empty overlay */}
        {messages.length > 0 ? (
          <MessageList />
        ) : !canInput ? (
          <NoModelEmptyState />
        ) : (
          <NewChatEmptyState isEmpty={isEmpty} onSuggestion={handleSuggestion} />
        )}

        {/* Input — always visible so the toggle is accessible even without a
            model. ChatInput handles the disabled state internally. */}
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
            sendFn={isAgentMode ? feralSend : undefined}
            alwaysEnabled={isAgentMode}
          />
        </div>
      </div>
    </div>
  );
}
