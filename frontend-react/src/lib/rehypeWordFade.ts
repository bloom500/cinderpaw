import { visit, SKIP } from 'unist-util-visit';
import type { Root, Element, Text } from 'hast';

/**
 * Rehype plugin: wrap each word of every text node in
 * `<span class="word-fade">`, so a CSS one-shot animation can fade words in as
 * they stream. Whitespace stays as bare text so line-wrapping is unaffected.
 *
 * Applied ONLY to the live-streaming assistant message. Because react-markdown
 * re-parses on every token, already-rendered word spans keep their tree
 * position → React reuses their DOM nodes → their animation does not re-run;
 * only newly appended words mount fresh and animate.
 *
 * Code/pre subtrees are skipped ENTIRELY (return SKIP on the element, so we
 * never descend) — otherwise text inside the hljs spans that rehype-highlight
 * injects, which are nested below <code>, would be word-wrapped and break
 * syntax highlighting and copy-paste.
 */
export function rehypeWordFade() {
  return (tree: Root) => {
    visit(tree, (node, index, parent) => {
      // Don't descend into code/pre — their inner text must stay intact.
      if (node.type === 'element') {
        const el = node as Element;
        if (el.tagName === 'code' || el.tagName === 'pre') return SKIP;
        return; // continue into other elements
      }

      if (node.type !== 'text' || parent == null || index == null) return;
      const value = (node as Text).value;
      if (!value || !/\S/.test(value)) return;

      // Split keeping whitespace as its own chunks: ["The", " ", "weather", …]
      const parts = value.split(/(\s+)/).filter((s) => s.length > 0);
      const replacement = parts.map((part): Element | Text => {
        if (/^\s+$/.test(part)) return { type: 'text', value: part };
        return {
          type: 'element',
          tagName: 'span',
          properties: { className: ['word-fade'] },
          children: [{ type: 'text', value: part }],
        };
      });

      (parent as Element).children.splice(index, 1, ...replacement);
      // Skip past the nodes we just inserted so we don't re-visit/re-wrap them.
      return [SKIP, index + replacement.length];
    });
  };
}
