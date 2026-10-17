import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Markdown } from '../markdown';
import { chunkRun } from '../emberLetters';

describe('Markdown math', () => {
  it('draws a $$ block as a formula, not as text', () => {
    const { container } = render(<Markdown>{'$$E = mc^2$$'}</Markdown>);
    expect(container.querySelector('.katex')).not.toBeNull();
  });

  // The agent reports costs in almost every message. With single-dollar math on,
  // everything between the two amounts becomes one formula.
  it('leaves prices alone', () => {
    const { container } = render(<Markdown>{'The run cost $4.49 and the probe $0.30.'}</Markdown>);
    expect(container.querySelector('.katex')).toBeNull();
    expect(container.textContent).toContain('$4.49');
    expect(container.textContent).toContain('$0.30');
  });
});

describe('Markdown mermaid', () => {
  it('keeps the source readable when the diagram cannot be drawn', () => {
    // jsdom has no layout, so mermaid's render fails here exactly as it does in
    // the app while a fence is still arriving: the user sees the source.
    const { container } = render(<Markdown>{'```mermaid\ngraph TD; A-->B;\n```'}</Markdown>);
    expect(container.textContent).toContain('graph TD; A-->B;');
  });
});

describe('Markdown ember (live writing)', () => {
  it('lights only the new letters, and keeps the old ones as the same DOM nodes', () => {
    const r1 = [chunkRun(0, 'Hello', 0)];
    const { container, rerender } = render(<Markdown ember={{ runs: r1, now: 10 }}>{'Hello'}</Markdown>);
    const h = container.querySelector('.ember-word > span');
    expect(h?.textContent).toBe('H');
    expect(h?.className).toBe('ember-in');

    const r2 = [...r1, chunkRun(5, ' world', 300)];
    rerender(<Markdown ember={{ runs: r2, now: 310 }}>{'Hello world'}</Markdown>);
    // Same element: React kept it, so its animation is not started again.
    expect(container.querySelector('.ember-word > span')).toBe(h);
    const lit = Array.from(container.querySelectorAll('.ember-in')).map((s) => s.textContent).join('');
    expect(lit).toContain('world');
  });

  it('goes back to plain text once every letter has finished', () => {
    const runs = [chunkRun(0, 'Hello', 0), chunkRun(5, ' world', 300)];
    const { container } = render(<Markdown ember={{ runs, now: 5_000 }}>{'# Title\n\nHello world'}</Markdown>);
    expect(container.querySelector('.ember-in, .ember-word')).toBeNull();
    const plain = render(<Markdown>{'# Title\n\nHello world'}</Markdown>).container;
    expect(container.innerHTML).toBe(plain.innerHTML);
  });

  it('finds a letter in a later block by its offset in the whole document', () => {
    const { container } = render(<Markdown ember={{ runs: [chunkRun(9, 'Hello', 0)], now: 10 }}>{'# Title\n\nHello'}</Markdown>);
    expect(Array.from(container.querySelectorAll('.ember-in')).map((s) => s.textContent).join('')).toBe('Hello');
    expect(container.querySelector('h1 .ember-word')).toBeNull();
  });

  it('takes out the words an edit removes', () => {
    const { container } = render(
      <Markdown ember={{ runs: [], out: [[0, 5]], now: 0 }}>{'Seven days'}</Markdown>,
    );
    expect(Array.from(container.querySelectorAll('.ember-out')).map((s) => s.textContent).join('')).toBe('Seven');
    expect(container.textContent).toBe('Seven days');
  });
});
