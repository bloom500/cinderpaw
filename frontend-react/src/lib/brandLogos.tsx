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

/** The canvas's Connect board: a 40px raised tile with a hairline, the mark or initial centred in it. */
export function BrandLogo({ id, name, className }: { id: string; name: string; className?: string }) {
  const key = SAME_AS[id] ?? id;
  const light = LOGOS[key];
  const dark = LOGOS[`${key}.dark`];
  const mark = 'size-6 object-contain';

  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex size-10 shrink-0 items-center justify-center rounded-[11px] border border-border-default bg-bg-elevated',
        'text-[17px] font-semibold text-text-primary',
        className,
      )}
    >
      {!light ? (
        name.trim().charAt(0).toUpperCase() || '?'
      ) : (
        <>
          <img src={light} alt="" className={cn(mark, dark && 'dark:hidden')} />
          {dark && <img src={dark} alt="" className={cn(mark, 'hidden dark:block')} />}
        </>
      )}
    </span>
  );
}
