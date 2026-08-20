import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { CodeBlock } from '@/components/chat/CodeBlock';
import { ExternalLink } from '@/components/chat/ExternalLink';
import { rehypeWordFade } from '@/lib/rehypeWordFade';

function InlineCode({ children }: { children?: React.ReactNode }) {
  return (
    <code className="px-1.5 py-0.5 rounded text-[0.85em] font-mono bg-bg-elevated border border-border-subtle text-text-secondary">
      {children}
    </code>
  );
}

export function Markdown({ children, animateWords }: { children: string; animateWords?: boolean }) {
  // Word-fade runs after highlight so it can skip code/pre nodes it produced.
  const rehypePlugins = animateWords
    ? [rehypeHighlight, rehypeWordFade]
    : [rehypeHighlight];
  return (
    <div className="prose dark:prose-invert max-w-none break-words [overflow-wrap:anywhere] text-text-primary prose-headings:text-text-primary prose-strong:text-text-primary prose-pre:p-0 prose-pre:bg-transparent prose-pre:border-none prose-a:text-brand prose-li:text-text-primary prose-p:text-text-primary">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={{
          pre:  CodeBlock as React.ComponentType<React.HTMLAttributes<HTMLPreElement>>,
          a:    ExternalLink as React.ComponentType<React.AnchorHTMLAttributes<HTMLAnchorElement>>,
          code: (({ className, children, ...props }) => {
            // Fenced code blocks are handled by CodeBlock via the `pre` component.
            // Only render inline code here (no language class on the element).
            const isBlock = typeof className === 'string' && className.startsWith('language-');
            if (isBlock) return <code className={className} {...props}>{children}</code>;
            return <InlineCode>{children}</InlineCode>;
          }) as React.ComponentType<React.HTMLAttributes<HTMLElement>>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
