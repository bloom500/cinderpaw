import { tauri } from '@/lib/tauri';
import { useModel } from '@/stores/model';
import { useCinderpawStore } from '@/stores/cinderpaw';
import { useNotifications } from '@/stores/notifications';
import { useSettings } from '@/stores/settings';

export const CHATGPT_ID = 'chatgpt';
export const MANAGE_USAGE = 'https://chatgpt.com/settings/usage';

/**
 * The order providers are listed in: the ChatGPT plan first, OpenAI's API key
 * last, the rest as they come, so Anthropic heads them (1 Nov, Darius:
 * subscriptions will be what most people use; the plan takes the key's place).
 */
export function planFirst<T extends { id: string }>(list: T[]): T[] {
  const rank = (id: string) => (id === CHATGPT_ID ? 0 : id === 'openai' ? 2 : 1);
  return [...list].sort((a, b) => rank(a.id) - rank(b.id));
}

/**
 * Sign in with ChatGPT and answer from that plan at once: the host opens the
 * browser, keeps the token and picks a model; this points both modes at it and
 * says so, since the work happened in another window. Resolves with the model;
 * a failure is thrown for the caller to show where the person is looking.
 */
export async function signInWithChatGPT(): Promise<string> {
  const model = await tauri.raw.chatgptSignIn();
  await useSettings.getState().fetchByok();
  useModel.getState().setCloudModel({ providerId: CHATGPT_ID, providerName: 'OpenAI Subscription', modelId: model });
  try {
    await useCinderpawStore.getState().setModel({ source: 'byok', providerId: CHATGPT_ID, model });
  } catch { /* the engine may still be starting; the picker offers it either way */ }
  useNotifications
    .getState()
    .push('success', "You're using your ChatGPT plan", `Cinderpaw's answers now count against your ChatGPT plan. See or limit it in Manage usage: ${MANAGE_USAGE}`);
  return model;
}
