import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { SAMPLE } from './markdownSample';

// Mermaid draws nothing in jsdom; a marker says the diagram road was taken.
vi.mock('@/components/chat/MermaidDiagram', () => ({
  MermaidDiagram: ({ code }: { code: string }) => <span data-mermaid>{code}</span>,
}));

import { Markdown, MarkdownBlock } from '../markdown';
import { splitBlocks } from '../markdownBlocks';

/**
 * The rendered HTML. A document parsed in one piece has a "\n" text node
 * between its top-level elements; blocks rendered apart do not. Whitespace
 * between block elements draws nothing and no `prose` selector sees it, so
 * those nodes, and only those, are dropped before comparing.
 */
function html(root: HTMLElement): string {
  for (const n of [...root.childNodes]) if (n.nodeType === Node.TEXT_NODE && !n.textContent?.trim()) n.remove();
  return root.innerHTML;
}

/** The document parsed in one piece, the way it rendered before blocks. */
function whole(md: string): string {
  const { container, unmount } = render(<div><MarkdownBlock text={md} fade={false} /></div>);
  const out = html(container.firstChild as HTMLElement);
  unmount();
  return out;
}

function split(md: string): string {
  const { container, unmount } = render(<Markdown>{md}</Markdown>);
  const out = html(container.firstChild as HTMLElement);
  unmount();
  return out;
}

const CORPUS: Record<string, string> = {
  'a real reply': SAMPLE,
  'a loose list': '- a\n\n- b\n\n- c\n\nAfter.',
  'a list that turns loose after a paragraph': 'Intro:\n- a\n- b\n\n- c\n\nEnd.',
  'an ordered list with paragraphs': '1. First\n\n   More about the first.\n\n2. Second\n\nDone.',
  'quotes': '> a\n>\n> b\n\n> c\n\nText',
  'block math with a blank line': 'Euler:\n\n$$\ne^{i\\pi} + 1 = 0\n\n$$\n\nAfter the math.',
  'one-line block math': 'Mass:\n\n$$E = mc^2$$\n\nThen text.',
  'a tilde fence with blank lines': '~~~\na\n\nb\n~~~\n\npara',
  'a fence inside a list item': '- item\n\n  ```js\n  a\n\n  b\n  ```\n\n- next',
  'reference links': 'See [the docs][1].\n\nMore.\n\n[1]: https://example.com',
  'a footnote': 'Text[^1]\n\nMore.\n\n[^1]: The note.',
  'setext heading and a rule': 'Title\n=====\n\npara\n\n---\n\nmore',
  'a table after a paragraph': 'Here:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nend',
  'indented code after a paragraph': 'para\n\n    code line\n\n    more\n\nend',
  'raw html': '<details>\n<summary>x</summary>\n\nhidden\n\n</details>\n\nafter',
  'nested lists': '- a\n  - a1\n\n  - a2\n- b\n\n1. one\n2. two\n\n   para in two\n\n3. three',
};

describe('a reply cut into blocks renders exactly as the whole reply', () => {
  for (const [name, md] of Object.entries(CORPUS)) {
    it(name, () => {
      expect(split(md)).toBe(whole(md));
    });
  }

  it('at every point while it streams', () => {
    for (let i = 1; i <= SAMPLE.length; i += 23) {
      const md = SAMPLE.slice(0, i);
      expect(split(md), `prefix of ${i} characters`).toBe(whole(md));
    }
  });

  it('is actually cut: a real reply is many blocks', () => {
    expect(splitBlocks(SAMPLE).length).toBeGreaterThan(8);
    expect(splitBlocks(CORPUS['reference links'])).toHaveLength(1);
  });
});

describe('code in a reply', () => {
  it('a fence is a highlighted block, not an inline pill', () => {
    const { container } = render(<Markdown>{'```ts\nconst a = 1;\n```\n\nand `inline` here'}</Markdown>);
    const [block, inline] = [...container.querySelectorAll('code')];
    expect(block.className).toMatch(/\bhljs\b/);
    expect(block.className).toMatch(/\blanguage-ts\b/);
    expect(block.className).not.toMatch(/border/);
    expect(inline.className).toMatch(/border/);
  });

  it('a mermaid fence is drawn as a diagram', () => {
    const { container } = render(<Markdown>{'```mermaid\ngraph TD; A-->B;\n```'}</Markdown>);
    expect(container.querySelector('[data-mermaid]')?.textContent).toBe('graph TD; A-->B;');
  });
});

describe('streaming', () => {
  it('keeps the finished blocks: their elements are not rebuilt as text arrives', () => {
    const { container, rerender } = render(<Markdown animateWords>{SAMPLE.slice(0, 900)}</Markdown>);
    const heading = container.querySelector('h2');
    const firstCode = container.querySelector('code');
    for (let i = 904; i <= SAMPLE.length; i += 4) rerender(<Markdown animateWords>{SAMPLE.slice(0, i)}</Markdown>);
    expect(container.querySelector('h2')).toBe(heading);
    expect(container.querySelector('code')).toBe(firstCode);
  });
});
