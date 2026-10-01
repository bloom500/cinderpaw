import { useEffect } from 'react';
import { APP_IFRAME_SANDBOX } from '@/lib/artifactSandbox';

/**
 * The sandboxed frame, and the one thing it tells the page while it is mounted.
 *
 * `data-live-frame` on <html> is there for the window glass to switch to its
 * no-displacement form (see globals.css). A counter, not a boolean, so two
 * frames closing in either order never leave the mark set or clear it early.
 * An attribute rather than a class, for the reason in lib/panelMotion.ts: a
 * class change on <html> restyles the whole page.
 */
let liveFrames = 0;
export function LiveFrame({ title, content, className = 'flex-1' }: { title: string; content: string; className?: string }) {
  useEffect(() => {
    liveFrames += 1;
    document.documentElement.toggleAttribute('data-live-frame', true);
    return () => {
      liveFrames -= 1;
      if (liveFrames === 0) document.documentElement.toggleAttribute('data-live-frame', false);
    };
  }, []);
  return (
    <iframe
      title={title}
      srcDoc={content}
      sandbox={APP_IFRAME_SANDBOX}
      className={`${className} border-0 bg-white`}
    />
  );
}
