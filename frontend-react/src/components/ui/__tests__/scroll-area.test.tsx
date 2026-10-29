import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { ScrollArea } from '../scroll-area';

describe('ScrollArea', () => {
  it('keeps its content as wide as the viewport, not as wide as its longest line', () => {
    // Radix sets `display: table` on the content, which grows to the widest
    // line: one long memory pushed every Context card past the panel and its
    // chevron off screen (29 Oct). jsdom has no layout, so the guard is the
    // rule that forces the content back to a block.
    const { container } = render(<ScrollArea><p>a line far longer than the panel it sits in</p></ScrollArea>);
    const viewport = container.querySelector('[data-radix-scroll-area-viewport]');
    expect(viewport?.className).toContain('[&>div]:block!');
  });
});
