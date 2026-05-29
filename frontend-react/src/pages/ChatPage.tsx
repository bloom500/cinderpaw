import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useChat } from '@/stores/chat';
import { useConversations } from '@/stores/conversations';
import { useModel } from '@/stores/model';
import { ChatHeader } from '@/components/chat/ChatHeader';
import { MessageList } from '@/components/chat/MessageList';
import { ChatInput } from '@/components/chat/ChatInput';
import { NoModelEmptyState, NewChatEmptyState } from '@/components/chat/EmptyStates';

export function ChatPage() {
  const { id } = useParams();
  const loaded = useModel((s) => s.loaded);
  const messages = useChat((s) => s.messages);
  const loadingConversation = useConversations((s) => s.loadingConversation);

  // Initial data hydration
  useEffect(() => {
    void useConversations.getState().refresh();
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

  return (
    <div className="flex flex-col h-full relative">
      {/* Thin loading bar while fetching conversation from disk */}
      {loadingConversation && (
        <div className="absolute inset-x-0 top-0 h-0.5 bg-brand animate-pulse z-10" />
      )}

      <ChatHeader />

      {!loaded ? (
        <NoModelEmptyState />
      ) : messages.length === 0 ? (
        <NewChatEmptyState />
      ) : (
        <MessageList />
      )}

      <ChatInput />
    </div>
  );
}
