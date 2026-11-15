import { invoke } from '@tauri-apps/api/core';
import { tauri } from '@/lib/tauri';
import { useChat } from '@/stores/chat';
import { useConversations } from '@/stores/conversations';
import { useOnboarding } from '@/stores/onboarding';

/**
 * The agent writes first, once, the moment a model is connected: in the
 * onboarding, or later after "Skip" (Fable's first-run report, 14 Nov: on a
 * new install Cinderpaw never spoke first, so a stranger met an empty box).
 *
 * The model writes it from the names of the apps on this computer, so it fits
 * the person without a fixed list of kinds of people (Darius, 14 Nov). The
 * engine files it as the agent's turn (core/welcome.ts) and answers with
 * `welcome_ready`; this file only shows it.
 */
const KEY = 'cinderpaw-welcome-v1';
const WAIT_MS = 30_000;
type State = 'waiting' | 'sent';

function read(): State | null {
  try { const v = localStorage.getItem(KEY); return v === 'waiting' || v === 'sent' ? v : null; } catch { return null; }
}
function write(v: State) {
  try { localStorage.setItem(KEY, v); } catch { /* private window: worst case it is offered again */ }
}

/**
 * Only when the engine cannot be reached. The same words as the engine's own
 * fallback (core/welcome.ts), which covers a model that fails.
 */
export function welcomeText(agentName: string, userName: string): string {
  const hi = userName.trim() ? `Hi ${userName.trim()}!` : 'Hi!';
  return [
    `${hi} I'm ${agentName.trim() || 'Cinderpaw'}, and I'm ready to help. 👋`,
    '',
    "You know those small things that keep slipping your mind? That's where I'm good. For example:",
    '',
    '- **"Remind me to call the dentist tomorrow at 10."** I will, right on time.',
    '- **"Tell me when tickets go on sale on this page."** I check it for you and only speak up when it happens.',
    '- **"Help me answer this email."** Paste it here and we write it together.',
    '',
    "What's one thing on your mind today?",
  ].join('\n');
}

const pending = new Map<string, (content: string) => void>();
/** The engine's `welcome_ready` event (hooks/useCinderpaw.ts). */
export function receiveWelcome(sessionId: string, content: string): void {
  pending.get(sessionId)?.(content);
  pending.delete(sessionId);
}

/**
 * Called by the home screen each time it checks for a model. `hasModel` false
 * means this person met the "needs a model" screen, so the first model they
 * add earns a welcome. A person who already has chats and never saw that
 * screen (an update, not a new install) is not greeted out of nowhere.
 */
export async function maybeWelcome(hasModel: boolean | null): Promise<void> {
  const state = read();
  if (state === 'sent' || hasModel === null) return;
  if (!hasModel) { if (state !== 'waiting') write('waiting'); return; }
  const convs = useConversations.getState();
  if (state !== 'waiting' && !(convs.loaded && convs.list.length === 0)) {
    if (convs.loaded) write('sent'); // chats from before this version: never greet
    return;
  }
  if (useChat.getState().messages.length > 0) return; // only on an empty home screen
  write('sent'); // before any wait, so a second check cannot send it twice
  const sessionId = useChat.getState().sessionId;

  const apps = await invoke<{ name: string }[]>('list_apps').catch(() => [] as { name: string }[]);
  const written = new Promise<string | null>((resolve) => {
    pending.set(sessionId, resolve);
    setTimeout(() => { pending.delete(sessionId); resolve(null); }, WAIT_MS);
  });
  const asked = await tauri.raw
    .cinderpawCronOp(crypto.randomUUID(), 'welcome', { sessionId, task: apps.map((a) => a.name).join('\n') })
    .then(() => true, () => false);
  if (!asked) receiveWelcome(sessionId, '');
  const content = (await written) || (() => {
    const { agentName, userName } = useOnboarding.getState();
    return welcomeText(agentName, userName);
  })();

  const chat = useChat.getState();
  // They moved to another chat or started talking while it was written.
  if (chat.sessionId !== sessionId || chat.messages.length > 0) return;
  chat.addMessage({ id: crypto.randomUUID(), role: 'assistant', content, createdAt: Date.now() });
  void useConversations.getState().saveCurrent('Welcome').catch(() => {});
}
