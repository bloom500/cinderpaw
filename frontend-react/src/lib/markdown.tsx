import { createContext, memo, useContext, useState } from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import 'katex/dist/katex.min.css';
import { Maximize2, X } from 'lucide-react';
import { CodeBlock } from '@/components/chat/CodeBlock';
import { MermaidDiagram } from '@/components/chat/MermaidDiagram';
import { ExternalLink } from '@/components/chat/ExternalLink';
import { rehypeWordFade } from '@/lib/rehypeWordFade';
import { splitBlocks } from '@/lib/markdownBlocks';

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
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-6"
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

/** True inside a fenced code block's <pre>: its <code> is a block, not an inline span. */
const InPre = createContext(false);

function Pre(props: React.HTMLAttributes<HTMLPreElement> & { node?: unknown }) {
  const { node: _node, ...rest } = props;
  return (
    <InPre.Provider value>
      <CodeBlock {...rest} />
    </InPre.Provider>
  );
}

/**
 * Inline code, a fenced block's <code>, or a Mermaid diagram. Which one is
 * decided by where it is, not by its class: rehype-highlight names a fence
 * "hljs language-ts", and a test for a class that *starts* with "language-"
 * sent every fence down the inline road, pill border and all, with the
 * theme's `.hljs` block style gone, and never drew a single diagram (25 Sep).
 */
function MarkdownCode({ className, children, node: _node, ...props }: React.HTMLAttributes<HTMLElement> & { node?: unknown }) {
  const inPre = useContext(InPre);
  if (!inPre) return <InlineCode>{children}</InlineCode>;
  if (/\blanguage-mermaid\b/.test(className ?? '')) return <MermaidDiagram code={String(children).trimEnd()} />;
  return <code className={className} {...props}>{children}</code>;
}

// Module constants, so every render hands react-markdown the same component
// types. An inline `code` arrow was a new component on every streamed token:
// React unmounted and remounted every code element and every diagram each
// time (1,324 code mounts streaming one 6 KB reply, 25 Sep).
const COMPONENTS: Components = {
  pre: Pre as Components['pre'],
  a: ExternalLink as Components['a'],
  table: ExpandableTable as unknown as Components['table'],
  code: MarkdownCode as Components['code'],
};
// `singleDollarTextMath: false` is deliberate: with it on, "it cost $4.49 and
// $0.30 in probes" is one inline formula, and this agent talks about money in
// almost every report. $$…$$ blocks and \(…\) still work, which is what a
// model writes when it means mathematics.
const REMARK = [remarkGfm, [remarkMath, { singleDollarTextMath: false }]] as NonNullable<React.ComponentProps<typeof ReactMarkdown>['remarkPlugins']>;
// Word-fade runs after highlight so it can skip code/pre nodes it produced.
// KaTeX before highlight, so a formula is a formula and not a code span.
const REHYPE = [rehypeKatex, rehypeHighlight];
const REHYPE_FADE = [rehypeKatex, rehypeHighlight, rehypeWordFade];

/**
 * One top-level block, parsed again only when its own text changes. The fade
 * going off when a reply ends is not a change: a word that has faded in looks
 * the same with its span or without, and parsing every block of the reply
 * again for it was one long frame at the end of every answer.
 */
export const MarkdownBlock = memo(
  function MarkdownBlock({ text, fade }: { text: string; fade: boolean }) {
    return (
      <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={fade ? REHYPE_FADE : REHYPE} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    );
  },
  (prev, next) => prev.text === next.text && (prev.fade === next.fade || !next.fade),
);

export function Markdown({ children, animateWords }: { children: string; animateWords?: boolean }) {
  // Cut into blocks that render the same apart as together (markdownBlocks):
  // while a reply streams, the finished blocks keep their DOM and only the
  // one still growing is parsed again.
  const blocks = splitBlocks(children);
  return (
    <div className="prose dark:prose-invert max-w-none wrap-break-word wrap-anywhere text-text-primary prose-headings:text-text-primary prose-strong:text-text-primary prose-pre:p-0 prose-pre:bg-transparent prose-pre:border-none prose-a:text-brand prose-li:text-text-primary prose-p:text-text-primary">
      {blocks.map((b, i) => <MarkdownBlock key={i} text={b} fade={Boolean(animateWords)} />)}
    </div>
  );
}
