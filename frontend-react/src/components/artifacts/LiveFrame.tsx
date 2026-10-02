import { useEffect, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { APP_IFRAME_SANDBOX } from '@/lib/artifactSandbox';
import { tauri } from '@/lib/tauri';

/**
 * The sandboxed frame, and the one thing it tells the page while it is mounted.
 *
 * `data-live-frame` on <html> is there for the window glass to switch to its
 * no-displacement form (see globals.css). A counter, not a boolean, so two
 * frames closing in either order never leave the mark set or clear it early.
 * An attribute rather than a class, for the reason in lib/panelMotion.ts: a
 * class change on <html> restyles the whole page.
 *
 * The page loads from the host's `cinderpaw-frame` scheme, not `srcdoc`: a
 * srcdoc frame inherits the window's CSP, which blocks every inline script in
 * an installed build (src-tauri/src/artifact_frame.rs). With no host (a test, a
 * plain browser) it falls back to srcdoc, which runs there because nothing
 * sets a CSP.
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

  // undefined while the host takes the page; null when there is no host.
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setSrc(undefined);
    Promise.resolve()
      .then(() => tauri.artifacts.frame(content))
      .then((token) => convertFileSrc(token, 'cinderpaw-frame'))
      .then((url) => { if (live) setSrc(url); }, () => { if (live) setSrc(null); });
    return () => { live = false; };
  }, [content]);

  if (src === undefined) return <div className={`${className} bg-white`} aria-busy="true" />;
  return (
    <iframe
      title={title}
      src={src ?? undefined}
      srcDoc={src === null ? content : undefined}
      sandbox={APP_IFRAME_SANDBOX}
      className={`${className} border-0 bg-white`}
    />
  );
}
