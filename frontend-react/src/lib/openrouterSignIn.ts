import { tauri } from '@/lib/tauri';
import { useModel } from '@/stores/model';
import { useCinderpawStore } from '@/stores/cinderpaw';
import { useNotifications } from '@/stores/notifications';

/**
 * The one-button way to give Cinderpaw a model: sign in with OpenRouter.
 *
 * The host opens the system browser, waits for OpenRouter's redirect and puts
 * the key in the keychain; this only picks the model it returns for BOTH modes,
 * so the person lands in a working chat whichever toggle they are on. Every
 * outcome is said on screen, success included, because the work happened in
 * another window and nothing here moved while it did.
 */
export async function signInWithOpenRouter(): Promise<boolean> {
  const notify = useNotifications.getState().push;
  try {
    const model = await tauri.raw.openrouterSignIn();
    useModel.getState().setCloudModel({ providerId: 'openrouter', providerName: 'OpenRouter', modelId: model });
    try {
      await useCinderpawStore.getState().setModel({ source: 'byok', providerId: 'openrouter', model });
    } catch { /* the sidecar may still be starting; Brain Stack picks the key up on its own */ }
    notify('success', 'Signed in with OpenRouter', 'Cinderpaw is ready. Ask it anything.');
    return true;
  } catch (err) {
    notify('error', 'Sign-in did not finish', String(err));
    return false;
  }
}
