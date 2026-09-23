import { useState } from 'react';
import { Globe, X } from 'lucide-react';
import { open } from '@tauri-apps/plugin-shell';
import { linkHost, linkLabel } from '@/lib/linkLabel';

/**
 * The icon is the site's own /favicon.ico. Some sites keep it elsewhere
 * (recorder.ro answers 404 there), so the second try is DuckDuckGo's icon
 * service, which is sent the site's name only, never the address. After that,
 * a globe.
 */
const iconSources = (host: string) => [
  `https://${host}/favicon.ico`,
  `https://icons.duckduckgo.com/ip3/${host}.ico`,
];

function SiteIcon({ href }: { href: string }) {
  const host = linkHost(href);
  const [attempt, setAttempt] = useState(0);
  const icon = host ? iconSources(host)[attempt] : undefined;
  return icon ? (
    <img
      key={icon}
      src={icon}
      alt=""
      width={14}
      height={14}
      loading="lazy"
      onError={() => setAttempt((n) => n + 1)}
      className="size-3.5 shrink-0 rounded-sm"
    />
  ) : (
    <Globe size={14} className="shrink-0" aria-hidden />
  );
}

/**
 * A link shown as the site's icon and a short name, instead of a hundred
 * characters of address. The full address is in the tooltip.
 *
 * In a sent message it opens in the real browser, like every other link in the
 * app (see ExternalLink). In the composer (`onRemove` given) it sits beside the
 * attached files: clicking it does nothing while you are still writing, and
 * the X takes it back out.
 */
export function LinkChip({ href, onRemove }: { href: string; onRemove?: () => void }) {
  const label = linkLabel(href);
  if (onRemove) {
    return (
      <span
        title={href}
        className="inline-flex max-w-[260px] items-center gap-1.5 rounded-md border border-border-default bg-bg-elevated px-2 py-0.5 text-xs font-medium text-text-secondary"
      >
        <SiteIcon href={href} />
        <span className="truncate">{label}</span>
        <button
          type="button"
          onClick={onRemove}
          className="ml-0.5 rounded hover:text-text-primary"
          aria-label={`Remove ${label}`}
        >
          <X size={12} />
        </button>
      </span>
    );
  }
  const onClick = (e: React.MouseEvent) => {
    e.preventDefault();
    void open(href).catch(() => window.open(href, '_blank', 'noopener,noreferrer'));
  };
  return (
    <a
      href={href}
      onClick={onClick}
      title={href}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-current/10 px-1.5 py-px align-baseline font-medium hover:bg-current/20 transition-colors"
    >
      <SiteIcon href={href} />
      <span className="truncate">{label}</span>
    </a>
  );
}
