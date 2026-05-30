import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useChat } from '@/stores/chat';
import { useConversations } from '@/stores/conversations';
import { useModel } from '@/stores/model';
import { useProjects } from '@/stores/projects';
import { ChatHeader } from '@/components/chat/ChatHeader';
import { MessageList } from '@/components/chat/MessageList';
import { ChatInput, type ChatInputHandle } from '@/components/chat/ChatInput';
import { NoModelEmptyState, NewChatEmptyState } from '@/components/chat/EmptyStates';

export function ChatPage() {
  const { id } = useParams();
  const loaded      = useModel((s) => s.loaded);
  const cloudModel  = useModel((s) => s.cloudModel);
  const messages    = useChat((s) => s.messages);
  const loadingConversation = useConversations((s) => s.loadingConversation);

  const hasModel = !!loaded || !!cloudModel;
  const isEmpty  = messages.length === 0 && hasModel;

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

  // Open conversation when route changes
  useEffect(() => {
    if (id) void useConversations.getState().open(id);
  }, [id]);

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

      {/* Positioning context for absolute children */}
      <div ref={containerRef} className="relative flex-1 overflow-hidden">
        {loadingConversation && (
          <div className="absolute inset-x-0 top-0 h-0.5 bg-brand animate-pulse z-10" />
        )}

        {/* Content: messages, no-model state, or empty overlay */}
        {messages.length > 0 ? (
          <MessageList />
        ) : !hasModel ? (
          <NoModelEmptyState />
        ) : (
          <NewChatEmptyState isEmpty={isEmpty} onSuggestion={handleSuggestion} />
        )}

        {/* Input — always at bottom-0, translated up when empty */}
        {(hasModel || messages.length > 0) && (
          <div
            ref={inputWrapperRef}
            style={{
              transform: `translateY(${translateY}px)`,
              transition: 'transform 350ms cubic-bezier(0.4, 0, 0.2, 1)',
            }}
            className="absolute inset-x-0 bottom-0 z-20"
          >
            <ChatInput ref={chatInputRef} isEmpty={isEmpty} />
          </div>
        )}
      </div>
    </div>
  );
}
