import type { NavigateFunction } from 'react-router-dom';
import { Box, Brain, FilePlus2, Globe, MessageSquarePlus, Settings, type LucideIcon } from 'lucide-react';
import { useConversations } from '@/stores/conversations';
import { useBrowser } from '@/stores/browser';
import { useArtifacts } from '@/stores/artifacts';
import { MOD } from '@/components/ui/kbd';

/**
 * The palette's named commands (spec 7.5, Command palette), in its three
 * sections, each with the shortcut `useGlobalHotkeys` answers. One list, so the
 * key the palette shows and the key that works cannot drift apart.
 */
export type CommandSection = 'Create' | 'Explore' | 'Configure';

export interface Command {
  id: string;
  section: CommandSection;
  label: string;
  hint: string;
  icon: LucideIcon;
  /** Extra words that should find it, never shown. */
  keywords?: string;
  keys?: string[];
  run: (navigate: NavigateFunction) => void;
}

/** A new chat with words already in the box (ChatPage reads `compose`). */
function compose(navigate: NavigateFunction, text: string) {
  useConversations.getState().newChat();
  navigate('/chat', { state: { compose: text } });
}

export const COMMANDS: Command[] = [
  {
    id: 'new-chat', section: 'Create', label: 'New chat', hint: 'Start a new conversation',
    icon: MessageSquarePlus, keys: [MOD, 'N'],
    // Called on the store, not announced as an event: from Models or Settings
    // the chat page is not mounted yet, so nobody would be listening.
    run: (navigate) => { useConversations.getState().newChat(); navigate('/chat'); },
  },
  {
    // The Home "Create" intent's words: the person says what to make.
    id: 'create-artifact', section: 'Create', label: 'Create artifact', hint: 'Write a document, page, or plan',
    icon: FilePlus2, keywords: 'document page plan write', keys: [MOD, 'Shift', 'A'],
    run: (navigate) => compose(navigate, 'Create '),
  },
  {
    // The browser lives beside the chat, and the two side panels do not share
    // the space (SideNav's Browser row does the same).
    id: 'open-browser', section: 'Explore', label: 'Open browser', hint: 'Search and browse the web',
    icon: Globe, keywords: 'web', keys: [MOD, 'B'],
    run: (navigate) => {
      useBrowser.getState().setPanel(true);
      useArtifacts.setState({ panelOpen: false });
      navigate('/chat');
    },
  },
  {
    // No key of its own: Ctrl K is the palette, and the palette already finds
    // past chats by what was said in them.
    id: 'search-memory', section: 'Explore', label: 'Search memory', hint: 'What Cinderpaw remembers about you',
    icon: Brain, keywords: 'facts forget remember',
    run: (navigate) => navigate('/settings?cat=memory'),
  },
  {
    // Ctrl on every system, never ⌘: ⌘M minimises the window on a Mac.
    id: 'switch-model', section: 'Configure', label: 'Switch model', hint: 'Choose, download or load a model',
    icon: Box, keywords: 'models download load local', keys: ['Ctrl', 'M'],
    run: (navigate) => navigate('/models'),
  },
  {
    id: 'settings', section: 'Configure', label: 'Settings', hint: 'Open app settings',
    icon: Settings, keys: [MOD, ','],
    run: (navigate) => navigate('/settings'),
  },
];

export function runCommand(id: string, navigate: NavigateFunction): void {
  COMMANDS.find((c) => c.id === id)?.run(navigate);
}
