import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConversations } from '@/stores/conversations';

export function useGlobalHotkeys() {
  const navigate = useNavigate();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      const target = e.target as HTMLElement | null;
      const inEditable =
        target != null &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);

      if (e.key.toLowerCase() === 'n' && !inEditable) {
        e.preventDefault();
        // Called on the store, not announced as an event: from Models or
        // Settings the chat page is not mounted yet, so nobody was listening and
        // Ctrl+N reopened the last conversation instead of starting one.
        useConversations.getState().newChat();
        navigate('/chat');
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
