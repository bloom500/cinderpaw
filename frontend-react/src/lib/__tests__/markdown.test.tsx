import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Markdown } from '../markdown';

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
