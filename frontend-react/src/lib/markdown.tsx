import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Maximize2, X } from 'lucide-react';
import { CodeBlock } from '@/components/chat/CodeBlock';
import { ExternalLink } from '@/components/chat/ExternalLink';
import { rehypeWordFade } from '@/lib/rehypeWordFade';

function ExpandableTable({ children, ...props }: React.HTMLAttributes<HTMLTableElement>) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <div className="relative group/table">
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="absolute top-1 right-1 p-1 rounded bg-bg-elevated border border-border-subtle shadow
                     opacity-0 group-hover/table:opacity-100 transition-opacity
                     text-text-muted hover:text-text-secondary cursor-pointer"
          aria-label="Expand table"
          title="Expand table"
        >
          <Maximize2 size={12} />
        </button>
        <div className="overflow-x-auto -mx-1">
          <table {...(props as any)}>{children}</table>
        </div>
      </div>
      {expanded && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
          onClick={() => setExpanded(false)}
        >
          <div
            className="relative bg-bg-elevated rounded-xl border border-border-default shadow-xl
                       max-w-5xl w-full max-h-[80vh] overflow-auto p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="absolute top-3 right-3 p-1.5 rounded-full bg-bg-surface border border-border-subtle
                         text-text-muted hover:text-text-primary cursor-pointer"
              aria-label="Close"
            >
              <X size={14} />
            </button>
            <div className="prose dark:prose-invert max-w-none">
              <table {...(props as any)}>{children}</table>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

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
          table: ExpandableTable as unknown as React.ComponentType<React.HTMLAttributes<HTMLTableElement>>,
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
