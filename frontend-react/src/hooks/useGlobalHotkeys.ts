import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { runCommand } from '@/lib/commands';

/** Close the browser panel if it is open, else the artifacts panel. True if one closed. */
async function closeSidePanel(): Promise<boolean> {
  const [{ useBrowser }, { useArtifacts }] = await Promise.all([import('@/stores/browser'), import('@/stores/artifacts')]);
  if (useBrowser.getState().panelOpen) { useBrowser.getState().setPanel(false); return true; }
  if (useArtifacts.getState().panelOpen) { useArtifacts.getState().togglePanel(); return true; }
  return false;
}

export function useGlobalHotkeys() {
  const navigate = useNavigate();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Esc closes the side panel (browser first, then artifacts), the way it
      // closes a sheet on a Mac. It stands aside for everything else that owns
      // Esc: the call screen (Esc hangs up there), any open dialog or menu, a
      // key some other handler already took, and single-line fields such as
      // the address bar, where Esc means "leave this field".
      if (e.key === 'Escape' && !e.defaultPrevented && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const el = e.target as HTMLElement | null;
        const busy =
          el?.tagName === 'INPUT' ||
          document.querySelector('[data-call-overlay], [role="dialog"], [role="menu"], [role="listbox"]') !== null;
        if (!busy) void closeSidePanel();
        return;
      }

      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      const target = e.target as HTMLElement | null;
      const inEditable =
        target != null &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);

      // The palette's commands (lib/commands.ts), the same keys it shows.
      const run = (id: string) => { e.preventDefault(); runCommand(id, navigate); };
      const key = e.key.toLowerCase();

      // Allowed from the composer too. Ctrl+N, Ctrl+Shift+A, Ctrl+B and Ctrl+M
      // mean nothing to a text field, and the composer holds the focus almost
      // all the time, so gating them on "not in an editable" made the
      // shortcuts dead exactly where people are.
      if (key === 'n' && !e.shiftKey && !e.altKey) run('new-chat');
      // Shift required: Ctrl+A alone is select-all.
      if (key === 'a' && e.shiftKey && !e.altKey) run('create-artifact');
      // Except inside a document being edited (ArtifactEditor), where Ctrl+B
      // is bold and the editor has already taken it.
      if (key === 'b' && !e.shiftKey && !e.altKey && !e.defaultPrevented &&
          !target?.closest?.('[contenteditable]:not([contenteditable="false"])')) run('open-browser');
      // Ctrl only, never ⌘: ⌘M minimises the window on a Mac.
      if (key === 'm' && e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) run('switch-model');

      // Ctrl+, opens Settings, the convention on both Windows and macOS apps.
      if (e.key === ',' && !inEditable) run('settings');

      if (e.key.toLowerCase() === 'k') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('cinderpaw:open-search'));
      }
    };

    const searchHandler = () => {
      import('@/stores/ui').then(({ useUI }) => {
        useUI.getState().openSearch();
      });
    };

    window.addEventListener('keydown', handler);
    window.addEventListener('cinderpaw:open-search', searchHandler);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('cinderpaw:open-search', searchHandler);
    };
  }, [navigate]);
}
