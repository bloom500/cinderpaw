import { createContext, useContext, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { useChat, type createChatStore } from './chat';
import type { ChatInputProps } from '@/components/chat/ChatInput';

export type ChatApi = ReturnType<typeof createChatStore>;

export interface ChatScope {
  store: ChatApi;
  name: string;
  mascot: ReactNode;
  send: ChatInputProps['sendFn'];
}

const Scope = createContext<ChatScope | null>(null);

export const ChatScopeProvider = Scope.Provider;
export const useChatScope = () => useContext(Scope);
export const useChatApi = (): ChatApi => useChatScope()?.store ?? useChat;

export function useChatView<T>(select: (state: ReturnType<ChatApi['getState']>) => T): T {
  return useStore(useChatApi(), select);
}
