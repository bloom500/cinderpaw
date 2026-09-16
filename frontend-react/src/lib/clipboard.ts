import { writeText as tauriWriteText } from '@tauri-apps/plugin-clipboard-manager';

/**
 * Put text on the clipboard, and say whether it worked.
 *
 * Three copy buttons in this app called the Tauri clipboard plugin directly,
 * inside a `try` whose `catch` did nothing. The plugin was never added to
 * Cargo.toml, never registered in lib.rs and never listed in
 * capabilities/default.json, so the IPC command did not exist: every copy
 * button in the app had always failed, silently, and the one that grew a tick
 * turned that into a button that claimed success it never had.
 *
 * The Rust side is fixed, but a user on a build made before that fix, or anyone
 * running this UI in a plain browser, still needs a working button. So each way
 * of copying is tried in turn and the caller is told the truth:
 *  1. the Tauri plugin, the only one that works when the webview is not a
 *     secure context;
 *  2. `navigator.clipboard`, which needs a secure context and permission;
 *  3. a hidden textarea and `execCommand('copy')`, deprecated and still the
 *     only thing that works in some embedded webviews.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await tauriWriteText(text);
    return true;
  } catch {
    /* not a Tauri window, or the plugin is missing from this build */
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* insecure context, or the user denied clipboard permission */
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // Off-screen rather than hidden: a display:none element cannot be selected.
    ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
