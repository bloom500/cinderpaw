import { useState, type ReactNode } from 'react';
import { Copy, Check } from 'lucide-react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';

interface CodeBlockProps extends React.HTMLAttributes<HTMLPreElement> {
  children?: ReactNode;
  // rehype-highlight passes the raw text node via children
}

function extractText(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (node && typeof node === 'object' && 'props' in (node as object)) {
    return extractText((node as React.ReactElement).props.children as ReactNode);
  }
  return '';
}

export function CodeBlock({ children, ...rest }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    const text = extractText(children);
    try {
      await writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };

  return (
    <pre {...rest} className="relative group overflow-x-auto max-w-full">
      <button
        type="button"
        onClick={onCopy}
        className="absolute top-2 right-2 p-1 rounded bg-bg-elevated border border-border-subtle text-text-muted opacity-0 group-hover:opacity-100 transition-opacity"
        aria-label="Copy code"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
      {children}
    </pre>
  );
}
