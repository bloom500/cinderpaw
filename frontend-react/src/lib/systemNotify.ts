/**
 * System notifications, for the moments the person is not looking.
 *
 * Only two moments earn one: a turn finished, and the agent has a question.
 * Both are sent only when the window is in the background; in the foreground
 * the answer is already on screen and a toast on top of it would be noise.
 * Until 20 Sep there was no path to the OS at all: a long task ended in
 * silence for anyone who had switched to another window, which is exactly
 * who a long task is for.
 */
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';

let permission: Promise<boolean> | null = null;

function granted(): Promise<boolean> {
  if (!permission) {
    permission = (async () => {
      try {
        if (await isPermissionGranted()) return true;
        return (await requestPermission()) === 'granted';
      } catch {
        // No plugin (a browser build, a test): never throw into the stream.
        return false;
      }
    })();
  }
  return permission;
}

/** True when the person is looking somewhere else than this window. */
export function inBackground(): boolean {
  try {
    return document.visibilityState === 'hidden' || !document.hasFocus();
  } catch {
    return false;
  }
}

/** One line of the answer for the notification body: no markdown, short. */
export function preview(text: string, max = 120): string {
  const line = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>]/g, '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Sends only when the window is in the background. Never throws. */
export async function notifyIfBackground(title: string, body: string): Promise<boolean> {
  if (!inBackground()) return false;
  if (!(await granted())) return false;
  try {
    sendNotification({ title, body });
    return true;
  } catch {
    return false;
  }
}
