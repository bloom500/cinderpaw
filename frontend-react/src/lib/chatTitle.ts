import { tauri, type InferParams, type Message } from '@/lib/tauri';
import { useModel } from '@/stores/model';
import { useCinderpawStore } from '@/stores/cinderpaw';
import { useConversations } from '@/stores/conversations';
import { autoTitle } from '@/lib/autoTitle';

/**
 * A short name for a conversation, written once after its first answer.
 *
 * The sidebar listed chats by their first message cut at 40 characters: "Da,
 * au pus, închide, închide aplicația;…". A title the model writes reads like
 * the subject instead. One small request per conversation, on the cloud model
 * the chat already uses; with no cloud model it does not run, and the
 * first-message title stays, which is what it always was.
 *
 * It never replaces a name the person chose: it runs only while the title is
 * still the derived one, and the rename it makes locks the title on disk the
 * same way a manual rename does.
 */
export async function titleConversation(id: string, messages: Pick<Message, 'role' | 'content'>[]): Promise<void> {
  try {
    const talk = messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim());
    // Once: right after the first answer, never on later turns.
    if (talk.filter((m) => m.role === 'assistant').length !== 1) return;
    const derived = autoTitle(talk as never);
    const row = useConversations.getState().list.find((c) => c.id === id);
    if (row && row.title !== derived) return;

    const route = pickCloud();
    if (!route) return;

    const firstUser = talk.find((m) => m.role === 'user')?.content ?? '';
    const firstReply = talk.find((m) => m.role === 'assistant')?.content ?? '';
    const params: InferParams = {
      temperature: 0.3,
      top_p: 0.9,
      repeat_penalty: 1.0,
      // Room for a reasoning model to think briefly before the few words.
      max_tokens: 200,
      system_prompt:
        'You name conversations. Reply with a title of 2 to 6 words, in the language the user wrote in. ' +
        'No quotes, no punctuation at the end, nothing else.',
      tools: null,
    };
    const ask: Message[] = [{
      role: 'user',
      content: `User: ${firstUser.slice(0, 600)}\n\nAssistant: ${firstReply.slice(0, 600)}`,
    }];
    const raw = await tauri.raw.chatCloudComplete(route.providerId, route.modelId, ask, params);
    const title = cleanTitle(raw);
    if (!title) return;
    // The person may have renamed it while the request was out.
    const now = useConversations.getState().list.find((c) => c.id === id);
    if (now && now.title !== derived) return;
    await useConversations.getState().rename(id, title);
  } catch (err) {
    // A name is a nicety: never an error on screen for it.
    console.warn('[chatTitle] skipped:', err);
  }
}

/** The cloud model the chat is using, in either mode; null when it is local. */
function pickCloud(): { providerId: string; modelId: string } | null {
  const cloud = useModel.getState().cloudModel;
  if (cloud) return { providerId: cloud.providerId, modelId: cloud.modelId };
  const agent = useCinderpawStore.getState().modelConfig;
  if (agent && agent.model && agent.provider && !/^(local|openai_compatible)$/.test(agent.provider)) {
    return { providerId: agent.provider, modelId: agent.model };
  }
  return null;
}

/** Strip what models add around a title: thinking, quotes, a label, a full stop. */
export function cleanTitle(raw: string): string {
  let t = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  t = t.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  t = t.replace(/^(title|titlu)\s*:\s*/i, '').replace(/^["'“”„«*#\s]+|["'“”«»*\s]+$/g, '').replace(/[.!]+$/, '').trim();
  if (t.length > 48) t = t.slice(0, 47).trimEnd() + '…';
  return t;
}
