import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useChat } from '@/stores/chat';
import { useConversations } from '@/stores/conversations';
import { useModel } from '@/stores/model';
import { useProjects } from '@/stores/projects';
import { useUI } from '@/stores/ui';
import { useAgent } from '@/stores/agent';
import { ChatHeader } from '@/components/chat/ChatHeader';
import { HomeGreeting } from '@/components/shell/HomeGreeting';
import { HomeIntents } from '@/components/shell/HomeIntents';
import { MessageList } from '@/components/chat/MessageList';
import { ChatInput, type ChatInputHandle } from '@/components/chat/ChatInput';
import { NewChatEmptyState } from '@/components/chat/EmptyStates';
import { AgentOfflineBanner } from '@/components/chat/AgentOfflineBanner';
import { StreamErrorNotice } from '@/components/chat/StreamErrorNotice';
import { AgentsOnboarding } from '@/components/agents/onboarding/AgentsOnboarding';
import { ONBOARDING_KEY } from '@/components/agents/agentUtils';
import { useOnboarding } from '@/stores/onboarding';
import { FeralGlobalMount } from '@/components/chat/FeralGlobalMount';
import { useFeralSendMessage } from '@/hooks/useFeral';
import { useFeralStore } from '@/stores/feral';

export function ChatPage() {
  const { id } = useParams();
  const loaded      = useModel((s) => s.loaded);
  const messages    = useChat((s) => s.messages);
  const loadingConversation = useConversations((s) => s.loadingConversation);

  const inputMode    = useUI((s) => s.inputMode);
  const setInputMode = useUI((s) => s.setInputMode);
  const sessionId    = useChat((s) => s.sessionId);
  const feralSend    = useFeralSendMessage(sessionId);
  const isAgentMode  = inputMode === 'agent';

  // The composer is always live. Feral used to gate the whole screen on
  // `hasModel`, which meant a fresh install — the one machine that has no
  // model by definition — met a dead end instead of a product. When there
  // is no model, ChatInput answers the first message itself and offers the
  // two ways forward.
  const isEmpty   = messages.length === 0;

  const containerRef    = useRef<HTMLDivElement>(null);
  const inputWrapperRef = useRef<HTMLDivElement>(null);
  const chatInputRef    = useRef<ChatInputHandle>(null);
  const [translateY, setTranslateY] = useState(0);
  // #17: agent-creation onboarding — shown in agent mode when no agent
  // exists, but never while the first-run wizard is still on screen.
  const [showAgentOnboarding, setShowAgentOnboarding] = useState(false);
  const wizardActive = useOnboarding((s) => s.active);

  // Recompute centering offset whenever isEmpty or onboarding visibility changes.
  // Without showAgentOnboarding in deps, the effect fires while the container
  // has near-zero height (onboarding dominates), leaving translateY ≈ 0 after
  // the onboarding exits even though isEmpty is still true.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const wrapper   = inputWrapperRef.current;
    if (!container || !wrapper) return;

    if (isEmpty && !showAgentOnboarding) {
      const containerH = container.offsetHeight;
      const inputH     = wrapper.offsetHeight;
      setTranslateY(-(containerH / 2 - inputH / 2));
    } else {
      setTranslateY(0);
    }
  }, [isEmpty, showAgentOnboarding]);

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
        // #17: no agent exists — offer the agent-creation onboarding. It was
        // previously unreachable (the "New agent" button navigated here and
        // nothing mounted it). Sequenced below so it never stacks on top of
        // the first-run wizard. Skip if already dismissed/completed (survives CTRL+R).
        else if (!localStorage.getItem(ONBOARDING_KEY)) setShowAgentOnboarding(true);
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
      {isAgentMode && showAgentOnboarding && !wizardActive && (
        <AgentsOnboarding
          onDone={() => setShowAgentOnboarding(false)}
          onSkip={() => setShowAgentOnboarding(false)}
        />
      )}
      {!showAgentOnboarding && <ChatHeader />}

      {isAgentMode && <FeralGlobalMount />}
      {isAgentMode && <AgentOfflineBanner />}

      {/* Positioning context for absolute children */}
      <div ref={containerRef} className="relative flex-1 overflow-hidden">
        {/* The transcript scrolls under the header, and without this the top
            line is sliced clean in half against the banner above it. A short
            fade says "there is more up there" instead. */}
        {messages.length > 0 && (
          <div className="pointer-events-none absolute inset-x-0 top-0 h-6 z-10 bg-gradient-to-b from-bg-primary/90 to-transparent" />
        )}
        {loadingConversation && (
          <div className="absolute inset-x-0 top-0 h-0.5 bg-brand animate-pulse z-10" />
        )}

        {/* Content: messages, no-model state, or empty overlay */}
        {messages.length > 0 ? (
          <MessageList />
        ) : (
          <NewChatEmptyState isEmpty={isEmpty} />
        )}

        {/* Input — always visible so the toggle is accessible even without a
            model. ChatInput handles the disabled state internally. */}
        <div
          ref={inputWrapperRef}
          style={{
            transform: `translateY(${translateY}px)`,
            transition: 'transform 350ms cubic-bezier(0.4, 0, 0.2, 1)',
          }}
          // No fade behind the composer at all. It was meant to let the
          // transcript slide out of sight, but once the theme tokens started
          // honouring opacity it rendered as a black wash around the field —
          // a shadow with no object casting it. The transcript's own top fade
          // does the "there is more" job now, and the composer sits on the
          // scene like everything else.
          className="absolute inset-x-0 bottom-0 z-20 pt-8"
        >
          {isEmpty && !showAgentOnboarding && <HomeGreeting />}
          {/* #10: humanized inference errors with a fix-it action */}
          <StreamErrorNotice />
          <ChatInput
            ref={chatInputRef}
            isEmpty={isEmpty}
            sendFn={isAgentMode ? feralSend : undefined}
            alwaysEnabled={isAgentMode}
          />
          {/* Inside the composer's wrapper, not floating near it: the wrapper
              is what gets centred, and its measured height is what the centring
              uses. Anything placed outside it would need the composer's height
              guessed a second time, and would drift the first time the field
              grew a line. */}
          {isEmpty && !showAgentOnboarding && <HomeIntents onPick={handleSuggestion} />}
        </div>
      </div>
    </div>
  );
}
