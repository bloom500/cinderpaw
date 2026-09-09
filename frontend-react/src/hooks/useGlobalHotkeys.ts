import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * What this platform calls the modifier, spelled the way its users read it.
 *
 * The handler below accepts Cmd on a Mac and Ctrl everywhere else, but the
 * places that ADVERTISE a shortcut had `⌘N` typed into them literally — so on
 * Windows, which is most people, the menu named a key the keyboard does not
 * have while the key that works went unmentioned. A hint that is wrong is
 * worse than no hint: it teaches the wrong thing and then looks broken.
 *
 * Exported from the same file as the handler on purpose. The label and the key
 * it describes cannot drift apart if they are written down once.
 */
export const MOD_KEY = /mac|iphone|ipad/i.test(
  (typeof navigator !== 'undefined' && (navigator.platform || navigator.userAgent)) || '',
)
  ? '⌘'
  : 'Ctrl+';

/** The full label for a shortcut, e.g. `Ctrl+K` or `⌘K`. */
export function shortcut(key: string): string {
  return `${MOD_KEY}${key.toUpperCase()}`;
}

export function useGlobalHotkeys() {
  const navigate = useNavigate();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      // No `inEditable` guard on either of these, and that is the fix.
      //
      // It used to skip Ctrl+N whenever the focus was in a text box. The guard
      // is the right instinct for a BARE letter, which a text box owns — but
      // these are modifier combos, and no text box does anything with Ctrl+N.
      // What the guard actually did was switch off "new chat" in the one place
      // hands are always resting: the composer. You could start a new chat from
      // anywhere except the thing you type into. Ctrl+K never had the guard, so
      // the two shortcuts also behaved differently for no reason a person could
      // see.
      if (e.key.toLowerCase() === 'n') {
        e.preventDefault();
        navigate('/chat');
        window.dispatchEvent(new CustomEvent('cinderpaw:new-chat'));
      }

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
