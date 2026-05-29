import { open } from '@tauri-apps/plugin-shell';
import type { ComponentProps } from 'react';

export function ExternalLink({ href, children, ...rest }: ComponentProps<'a'>) {
  const onClick = (e: React.MouseEvent) => {
    e.preventDefault();
    if (href) void open(href);
  };
  return (
    <a href={href} onClick={onClick} className="text-brand hover:underline" {...rest}>
      {children}
    </a>
  );
}
