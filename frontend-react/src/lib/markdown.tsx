import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { CodeBlock } from '@/components/chat/CodeBlock';
import { ExternalLink } from '@/components/chat/ExternalLink';

export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose dark:prose-invert max-w-none text-text-primary prose-headings:text-text-primary prose-strong:text-text-primary prose-pre:bg-bg-elevated prose-pre:border prose-pre:border-border-subtle prose-code:text-brand prose-a:text-brand prose-li:text-text-primary prose-p:text-text-primary">
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
