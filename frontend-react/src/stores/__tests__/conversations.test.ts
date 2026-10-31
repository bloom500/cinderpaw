// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tauri, type Conversation } from '@/lib/tauri';
import { useChat } from '../chat';
import { useConversations } from '../conversations';
import { useNotifications } from '../notifications';
import { useArtifacts } from '../artifacts';

vi.mock('@/lib/tauri', () => ({
  tauri: {
    conversations: { load: vi.fn(), list: vi.fn(async () => []), delete: vi.fn(async () => {}), save: vi.fn(async () => {}) },
    cinderpawAgent: { coworkHistory: vi.fn(async () => {}) },
  },
}));
vi.mock('@/lib/cinderpawLiveSession', () => ({ rehydrateLiveSession: vi.fn() }));

function pending() {
  let resolve!: (c: Conversation) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<Conversation>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function conversation(id: string): Conversation {
  return { id, title: id, created_at: '', updated_at: '', messages: [{ role: 'user', content: id }] } as Conversation;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('window', globalThis);
  useConversations.getState().newChat();
  useConversations.setState({ streamingIds: {}, unreadIds: {} });
  useNotifications.setState({ toasts: [] });
});

describe('the latest conversation choice wins', () => {
  it('hides the previous artifact on a new chat without discarding its edit', () => {
    const editing = { draft: 'Unsaved changes', base: 1 };
    useArtifacts.setState({ panelOpen: true, editing });
    useConversations.getState().newChat();
    expect(useArtifacts.getState().panelOpen).toBe(false);
    expect(useArtifacts.getState().editing).toBe(editing);
    useArtifacts.setState({ editing: null });
  });
  it('keeps provider waits with their session and clears them when a turn ends', () => {
    useConversations.getState().markStreaming('waiting');
    useConversations.getState().setProviderWait('waiting', 30_000);
    const until = useConversations.getState().providerWaits.waiting;
    useConversations.getState().newChat();
    expect(useConversations.getState().providerWaits.waiting).toBe(until);
    useConversations.getState().unmarkStreaming('waiting');
    expect(useConversations.getState().providerWaits.waiting).toBeUndefined();
    useConversations.getState().setProviderWait('waiting', 30_000);
    expect(useConversations.getState().providerWaits.waiting).toBeUndefined();
  });

  it('ignores a previous chat that finishes after the selected chat', async () => {
    const a = pending(), b = pending();
    vi.mocked(tauri.conversations.load).mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const first = useConversations.getState().open('A');
    const second = useConversations.getState().open('B');
    b.resolve(conversation('B')); await second;
    a.resolve(conversation('A')); await first;
    expect(useChat.getState().messages[0].content).toBe('B');
    expect(useConversations.getState().currentId).toBe('B');
  });

  it('keeps loading until the selected chat finishes', async () => {
    const a = pending(), b = pending();
    vi.mocked(tauri.conversations.load).mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const first = useConversations.getState().open('A');
    const second = useConversations.getState().open('B');
    a.resolve(conversation('A')); await first;
    expect(useConversations.getState().loadingConversation).toBe(true);
    b.resolve(conversation('B')); await second;
    expect(useConversations.getState().loadingConversation).toBe(false);
  });

  it('keeps a new chat when an older load finishes', async () => {
    const a = pending();
    vi.mocked(tauri.conversations.load).mockReturnValueOnce(a.promise);
    const first = useConversations.getState().open('A');
    useConversations.getState().newChat();
    const fresh = useChat.getState().sessionId;
    expect(useConversations.getState().loadingConversation).toBe(false);
    a.resolve(conversation('A')); await first;
    expect(useChat.getState().sessionId).toBe(fresh);
    expect(useChat.getState().messages).toEqual([]);
  });

  it('does not replace a resident live chat with a pending disk load', async () => {
    const a = pending();
    vi.mocked(tauri.conversations.load).mockReturnValueOnce(a.promise);
    useChat.getState().loadSession('live', [{ id: 'reply', role: 'assistant', content: 'Still writing', createdAt: 1 }], 'streaming');
    useConversations.getState().markStreaming('live');
    const first = useConversations.getState().open('A');
    await useConversations.getState().open('live');
    a.resolve(conversation('A')); await first;
    expect(useChat.getState().sessionId).toBe('live');
    expect(useChat.getState().messages[0].content).toBe('Still writing');
    expect(useConversations.getState().loadingConversation).toBe(false);
  });

  it('discards a failure belonging to a chat the person left', async () => {
    const a = pending();
    vi.mocked(tauri.conversations.load).mockReturnValueOnce(a.promise);
    const first = useConversations.getState().open('A');
    useConversations.getState().newChat();
    a.reject(new Error('Old chat missing')); await first;
    expect(useNotifications.getState().toasts).toEqual([]);
  });

  it('still reports a failure of the selected chat', async () => {
    vi.mocked(tauri.conversations.load).mockRejectedValueOnce(new Error('Chat missing'));
    await useConversations.getState().open('A');
    expect(useNotifications.getState().toasts[0]?.title).toBe('Could not open the chat');
    expect(useConversations.getState().loadingConversation).toBe(false);
  });

  it('does not select a chat whose save finishes after navigation', async () => {
    let saved!: () => void;
    vi.mocked(tauri.conversations.save).mockReturnValueOnce(new Promise<void>((resolve) => { saved = resolve; }));
    useChat.getState().loadSession('A', []);
    const saving = useConversations.getState().saveCurrent('A');
    useConversations.getState().newChat();
    saved(); await saving;
    expect(useConversations.getState().currentId).toBeNull();
  });

  it('does not reopen a deleted chat when its load finishes', async () => {
    const a = pending();
    vi.mocked(tauri.conversations.load).mockReturnValueOnce(a.promise);
    const first = useConversations.getState().open('A');
    await useConversations.getState().delete('A');
    a.resolve(conversation('A')); await first;
    expect(useConversations.getState().currentId).toBeNull();
    expect(useChat.getState().messages).toEqual([]);
  });
});
