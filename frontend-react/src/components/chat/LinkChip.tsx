import { useState } from 'react';
import { Globe } from 'lucide-react';
import { open } from '@tauri-apps/plugin-shell';
import { linkHost, linkLabel } from '@/lib/linkLabel';

/**
 * A pasted link shown as the site's icon and a short name, instead of a
 * hundred characters of address. Opens in the real browser, like every other
 * link in the app (see ExternalLink). The full address is in the tooltip.
 *
 * The icon is the site's own /favicon.ico. Some sites keep it elsewhere
 * (recorder.ro answers 404 there), so the second try is DuckDuckGo's icon
 * service, which is sent the site's name only, never the address. After that,
 * a globe.
 */
const iconSources = (host: string) => [
  `https://${host}/favicon.ico`,
  `https://icons.duckduckgo.com/ip3/${host}.ico`,
];

export function LinkChip({ href }: { href: string }) {
  const host = linkHost(href);
  const [attempt, setAttempt] = useState(0);
  const icon = host ? iconSources(host)[attempt] : undefined;
  const onClick = (e: React.MouseEvent) => {
    e.preventDefault();
    void open(href).catch(() => window.open(href, '_blank', 'noopener,noreferrer'));
  };
  return (
    <a
      href={href}
      onClick={onClick}
      title={href}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-black/10 px-1.5 py-px align-baseline font-medium hover:bg-black/20 transition-colors"
    >
      {icon ? (
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
      )}
      <span className="truncate">{linkLabel(href)}</span>
    </a>
  );
}
