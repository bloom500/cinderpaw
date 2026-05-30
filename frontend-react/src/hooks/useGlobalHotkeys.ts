import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

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
        navigate('/chat');
        window.dispatchEvent(new CustomEvent('feral:new-chat'));
      }

      if (e.key.toLowerCase() === 'k') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('feral:open-search'));
      }
    };

    const searchHandler = () => {
      import('@/stores/ui').then(({ useUI }) => {
        useUI.getState().openSearch();
      });
    };

    window.addEventListener('keydown', handler);
    window.addEventListener('feral:open-search', searchHandler);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('feral:open-search', searchHandler);
    };
  }, [navigate]);
}
