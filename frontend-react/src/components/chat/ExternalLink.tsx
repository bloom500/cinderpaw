import { open } from '@tauri-apps/plugin-shell';
import type { ComponentProps } from 'react';

/**
 * A link that opens in the user's real browser instead of inside the app.
 *
 * The `catch` is the point. This component called `preventDefault()` and then
 * dropped the promise with `void`, so when the shell plugin was missing from
 * the Rust side every link in the app — including the "get your API key here"
 * buttons on onboarding, and every link the agent writes, via markdown.tsx —
 * did nothing at all and said nothing about it. A dead link that reports
 * nothing is worse than one that opens in the wrong place, and this also makes
 * the component work when the frontend is not running inside Tauri at all.
 */
export function ExternalLink({ href, children, ...rest }: ComponentProps<'a'>) {
  const onClick = (e: React.MouseEvent) => {
    if (!href) return;
    e.preventDefault();
    void open(href).catch(() => {
      window.open(href, '_blank', 'noopener,noreferrer');
    });
  };
  return (
    <a href={href} onClick={onClick} className="text-brand hover:underline" {...rest}>
      {children}
    </a>
  );
}
