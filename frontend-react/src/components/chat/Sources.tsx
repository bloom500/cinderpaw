import { createContext, useContext, type ComponentProps } from 'react';
import { open } from '@tauri-apps/plugin-shell';
import type { ToolHit } from '@/hooks/useLiveToolActivity';
import { normalizeUrl, siteName } from '@/lib/sources';
import { ExternalLink } from './ExternalLink';

/** This reply's search results, by normalised URL (`sourcesOf`). Empty outside a reply. */
export const SourcesContext = createContext<ReadonlyMap<string, ToolHit>>(new Map());

function openUrl(url: string) {
  void open(url).catch(() => window.open(url, '_blank', 'noopener,noreferrer'));
}

/** A small chip with the site's name, for a page Cinderpaw read. */
export function SourceChip({ hit }: { hit: ToolHit }) {
  return (
    <a
      href={hit.url}
      title={hit.title || hit.url}
      onClick={(e) => { e.preventDefault(); openUrl(hit.url); }}
      className="not-prose mx-0.5 inline-flex max-w-48 items-center rounded-full bg-bg-active px-2 py-px align-baseline text-2xs font-medium text-brand no-underline hover:bg-bg-active/70"
    >
      <span className="truncate">{siteName(hit)}</span>
    </a>
  );
}

/**
 * Markdown's link. One of this reply's search results becomes a source chip,
 * after the words the model linked (unless the words were the address itself);
 * any other link stays a normal link.
 */
export function SourceAwareLink({ href, children, ...rest }: ComponentProps<'a'>) {
  const sources = useContext(SourcesContext);
  const key = href ? normalizeUrl(href) : null;
  const hit = key ? sources.get(key) : undefined;
  if (!hit) return <ExternalLink href={href} {...rest}>{children}</ExternalLink>;
  const words = typeof children === 'string' ? children : Array.isArray(children) && children.every((c) => typeof c === 'string') ? children.join('') : null;
  const bare = words !== null && (words === href || normalizeUrl(words) === key);
  return (
    <>
      {!bare && children}
      <SourceChip hit={hit} />
    </>
  );
}

/** The list that closes an answer: every result it cited, in order. */
export function SourcesList({ hits }: { hits: ToolHit[] }) {
  if (hits.length === 0) return null;
  return (
    <section aria-label="Sources" className="mt-1 border-t border-border-subtle pt-3">
      <p className="mb-2 text-2xs font-semibold uppercase tracking-wider text-text-disabled">Sources</p>
      <ol className="flex flex-col gap-1.5">
        {hits.map((h, i) => (
          <li key={h.url} className="flex min-w-0 items-baseline gap-2 text-sm">
            <span className="w-4 shrink-0 text-right text-2xs tabular-nums text-text-disabled">{i + 1}</span>
            <button type="button" onClick={() => openUrl(h.url)} title={h.url}
              className="min-w-0 truncate text-left text-text-primary hover:text-brand">
              {h.title || siteName(h)}
            </button>
            <span className="shrink-0 text-2xs text-text-disabled">{siteName(h)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
