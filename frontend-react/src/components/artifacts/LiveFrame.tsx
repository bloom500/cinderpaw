import { useEffect, useMemo, useRef, useState } from 'react';
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
/** Printed designs declare their canvas in CSS. Responsive apps have no page size. */
function pageSize(content: string) {
  // Read dimensions as text; never instantiate untrusted markup in the host.
  const styles = Array.from(content.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi), (m) => m[1])
    .join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
  const match = /@page\s*\{[^}]*?\bsize\s*:\s*([\d.]+)(px|mm|cm|in|pt)\s+([\d.]+)(px|mm|cm|in|pt)\s*[;}]/i.exec(styles);
  if (!match) return null;
  const units: Record<string, number> = { px: 1, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, pt: 96 / 72 };
  const width = Number(match[1]) * units[match[2].toLowerCase()];
  const height = Number(match[3]) * units[match[4].toLowerCase()];
  return width >= 100 && height >= 100 && width <= 10000 && height <= 10000 ? { width, height } : null;
}

export function LiveFrame({ title, content, className = 'flex-1' }: { title: string; content: string; className?: string }) {
  const page = useMemo(() => pageSize(content), [content]);
  const host = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [fit, setFit] = useState(true);
  useEffect(() => {
    const el = host.current;
    if (!el || !page || typeof ResizeObserver === 'undefined') return;
    const measure = () => setBounds({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [page]);
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

  const scale = page && fit ? Math.min(1, bounds.width / page.width, bounds.height / page.height) : 1;
  const frame = src === undefined ? <div className="h-full w-full bg-bg-elevated" aria-busy="true" /> : (
    <iframe title={title} src={src ?? undefined} srcDoc={src === null ? content : undefined}
      sandbox={APP_IFRAME_SANDBOX} className="h-full w-full border-0 bg-white" />
  );
  if (!page) return <div className={`${className} min-h-0 min-w-0`}>{frame}</div>;
  return (
    <div className={`${className} flex min-h-0 min-w-0 flex-col`}>
      <div className="flex shrink-0 items-center justify-between border-b border-border-subtle px-3 py-2 text-xs text-text-muted">
        <span>{fit ? 'Fit page' : 'Actual size'}</span>
        <button type="button" onClick={() => setFit((v) => !v)} className="rounded-md px-2 py-1 text-text-primary hover:bg-bg-hover">
          {fit ? 'Actual size' : 'Fit page'}
        </button>
      </div>
      <div ref={host} className="relative min-h-0 flex-1 overflow-auto bg-bg-elevated">
        <div className="overflow-hidden" style={{ width: page.width * scale, height: page.height * scale, margin: fit ? 'auto' : undefined }}>
          <div style={{ width: page.width, height: page.height, transform: `scale(${scale})`, transformOrigin: 'top left' }}>{frame}</div>
        </div>
      </div>
    </div>
  );
}
