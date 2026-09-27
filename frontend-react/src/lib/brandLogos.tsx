import { cn } from '@/lib/utils';

/**
 * A company's official logo, bundled with the app so nothing is fetched to draw it.
 *
 * The files live in `src/assets/brands/`, named by the id the connector or MCP
 * preset already uses; `<id>.dark.svg` is the brand's own version for dark
 * grounds. Sources: svgl.app (original colours), and Simple Icons 16.33.0 (one
 * colour, the brand's hex) for the ones svgl does not have. The marks remain
 * their owners' trademarks, shown to name the service they belong to.
 *
 * Drawn with <img>, so a file can never run anything, and two files' gradient
 * ids cannot collide. A name with no file gets its initial on a quiet tile.
 */
const FILES = import.meta.glob('../assets/brands/*.svg', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
const LOGOS: Record<string, string> = Object.fromEntries(
  Object.entries(FILES).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1, -'.svg'.length), url]),
);

/** Catalog ids that are the same company. */
const SAME_AS: Record<string, string> = { zalouser: 'zalo' };

export function BrandLogo({ id, name, className }: { id: string; name: string; className?: string }) {
  const key = SAME_AS[id] ?? id;
  const light = LOGOS[key];
  const dark = LOGOS[`${key}.dark`];
  const box = cn('size-8 shrink-0 rounded object-contain', className);

  if (!light) {
    return (
      <span aria-hidden className={cn(box, 'inline-flex items-center justify-center bg-bg-hover text-sm font-semibold text-text-muted')}>
        {name.trim().charAt(0).toUpperCase() || '?'}
      </span>
    );
  }
  return (
    <>
      <img src={light} alt="" className={cn(box, dark && 'dark:hidden')} />
      {dark && <img src={dark} alt="" className={cn(box, 'hidden dark:block')} />}
    </>
  );
}
