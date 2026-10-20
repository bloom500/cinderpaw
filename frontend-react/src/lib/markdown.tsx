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
import { SourceAwareLink } from '@/components/chat/Sources';
import { rehypeWordFade } from '@/lib/rehypeWordFade';
import { splitBlocks } from '@/lib/markdownBlocks';
import { emberActive, rehypeEmber, type Ember } from '@/lib/emberLetters';
import type { Element as HastElement, Root as HastRoot, Text as HastText } from 'hast';

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
        {/* No negative margin: -mx-1 cut the first column's text where the
            row clipped at its edge. */}
        <div className="overflow-x-auto">
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
  // A link to a page this reply's search found is a source chip; any other
  // link is a normal link (SourceAwareLink falls back to ExternalLink).
  a: SourceAwareLink as Components['a'],
  table: ExpandableTable as unknown as Components['table'],
  code: MarkdownCode as Components['code'],
};
// `singleDollarTextMath: false` is deliberate: with it on, "it cost $4.49 and
// $0.30 in probes" is one inline formula, and this agent talks about money in
// almost every report. $$…$$ blocks and \(…\) still work, which is what a
// model writes when it means mathematics.
const REMARK = [remarkGfm, [remarkMath, { singleDollarTextMath: false }]] as NonNullable<React.ComponentProps<typeof ReactMarkdown>['remarkPlugins']>;
// Word-fade runs after highlight so it can skip code/pre nodes it produced.
/**
 * A paragraph that is only `[[what goes here]]` is a part still to be written
 * (a document drafted in parts, artifact.ts DRAFT_IN_PARTS): drawn as a grey
 * line without its brackets, the way Claude Docs shows a pending block. The
 * text keeps its source offset, so live writing can take it out letter by letter.
 */
function rehypePlaceholder() {
  return (tree: HastRoot) => {
    for (const node of tree.children) {
      if (node.type !== 'element' || node.tagName !== 'p' || node.children.length !== 1) continue;
      const only = node.children[0];
      if (only?.type !== 'text') continue;
      const m = /^\[\[([^\]\n]+)\]\]$/.exec(only.value);
      if (!m) continue;
      (node as HastElement).properties = { ...node.properties, className: ['md-placeholder'] };
      const text = only as HastText;
      const start = text.position?.start.offset;
      text.value = m[1]!;
      if (start !== undefined && text.position) text.position = { ...text.position, start: { ...text.position.start, offset: start + 2 } };
    }
  };
}

// KaTeX before highlight, so a formula is a formula and not a code span.
const REHYPE = [rehypePlaceholder, rehypeKatex, rehypeHighlight];
const REHYPE_FADE = [rehypePlaceholder, rehypeKatex, rehypeHighlight, rehypeWordFade];

/**
 * One top-level block, parsed again only when its own text changes. The fade
 * going off when a reply ends is not a change: a word that has faded in looks
 * the same with its span or without, and parsing every block of the reply
 * again for it was one long frame at the end of every answer.
 */
export const MarkdownBlock = memo(
  function MarkdownBlock({ text, fade, ember }: { text: string; fade: boolean; ember?: Ember & { base: number } }) {
    // Ember goes last, after maths and highlighting, so it can leave their
    // nodes alone.
    const rehype = ember
      ? ([...REHYPE, [rehypeEmber, { ...ember, source: text }]] as typeof REHYPE)
      : fade ? REHYPE_FADE : REHYPE;
    return (
      <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={rehype} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    );
  },
  (prev, next) => prev.text === next.text && prev.ember === next.ember && (prev.fade === next.fade || !next.fade),
);

/**
 * `ember` is the Artifacts panel's live writing (emberLetters.ts): letters
 * arrive one by one as Cinderpaw writes, and an edit's old words go out. Only
 * a block with something still moving is parsed with it; every other block is
 * exactly what it is without it, so a settled document is plain markdown.
 */
export function Markdown({ children, animateWords, ember }: { children: string; animateWords?: boolean; ember?: Ember }) {
  // Cut into blocks that render the same apart as together (markdownBlocks):
  // while a reply streams, the finished blocks keep their DOM and only the
  // one still growing is parsed again.
  const blocks = splitBlocks(children);
  // Blocks are the document cut at newlines, so each starts one past the last.
  let base = 0;
  return (
    <div className="prose dark:prose-invert max-w-none wrap-break-word wrap-anywhere text-text-primary prose-headings:text-text-primary prose-strong:text-text-primary prose-pre:p-0 prose-pre:bg-transparent prose-pre:border-none prose-a:text-brand prose-li:text-text-primary prose-p:text-text-primary">
      {blocks.map((b, i) => {
        const start = base;
        base += b.length + 1;
        // The block the cursor is in is drawn with it even when nothing in it moves.
        const hasCaret = !!ember?.caret && ember.caret.at >= start && ember.caret.at <= start + b.length;
        const live = ember && (hasCaret || emberActive(ember, start, start + b.length))
          ? { ...ember, base: start, caret: hasCaret ? ember.caret : undefined }
          : undefined;
        return <MarkdownBlock key={i} text={b} fade={Boolean(animateWords)} ember={live} />;
      })}
    </div>
  );
}
