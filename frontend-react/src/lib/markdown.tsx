import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { CodeBlock } from '@/components/chat/CodeBlock';
import { ExternalLink } from '@/components/chat/ExternalLink';

export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose prose-invert max-w-none prose-pre:bg-bg-surface prose-pre:border prose-pre:border-border-subtle prose-code:text-brand">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre: CodeBlock as React.ComponentType<React.HTMLAttributes<HTMLPreElement>>,
          a: ExternalLink as React.ComponentType<React.AnchorHTMLAttributes<HTMLAnchorElement>>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
