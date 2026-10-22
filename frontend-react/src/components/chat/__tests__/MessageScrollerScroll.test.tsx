import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  MessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
} from '@shadcn/react/message-scroller';

// fastMessageScroller (vite.config.ts): a scroll in a long chat reads the size
// of a few rows, not every row. Unpatched, this scroll read ~1,500 rects.

const ROWS = 600;
const ROW = 100; // each row: 80 px tall, then a 20 px gap
const VIEW = 800;
let scrollTop = 0;
let rectReads = 0;

function State() {
  const { end } = useMessageScrollerScrollable();
  const { currentAnchorId } = useMessageScrollerVisibility();
  return <output data-testid="state">{`${currentAnchorId}|${end}`}</output>;
}

beforeEach(() => {
  // jsdom lays nothing out: place row i at i*100 px, the viewport at 0..800.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    rectReads++;
    const id = (this as HTMLElement).dataset?.messageId;
    if (id) return new DOMRect(0, Number(id.slice(1)) * ROW - scrollTop, 700, 80);
    if (this.getAttribute('aria-label') === 'Conversation') return new DOMRect(0, 0, 700, VIEW);
    return new DOMRect();
  });
  // The scroller's visibility path in every real browser.
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('a scroll in a 600-message chat reads a handful of rows and still knows where you are', async () => {
  render(
    <MessageScroller.Provider>
      <MessageScroller.Root>
        <MessageScroller.Viewport aria-label="Conversation">
          <MessageScroller.Content>
            {Array.from({ length: ROWS }, (_, i) => (
              // Even rows are your questions, odd rows the replies.
              <MessageScroller.Item key={i} messageId={`m${i}`} scrollAnchor={i % 2 === 0}>row</MessageScroller.Item>
            ))}
          </MessageScroller.Content>
        </MessageScroller.Viewport>
        <State />
      </MessageScroller.Root>
    </MessageScroller.Provider>,
  );
  const viewport = screen.getByRole('region', { name: 'Conversation' });
  Object.defineProperty(viewport, 'clientHeight', { value: VIEW });
  Object.defineProperty(viewport, 'scrollTop', { get: () => scrollTop, set: (v) => { scrollTop = v; } });

  // Halfway down: row 300 (a question) sits at the top, 64 px above the
  // reading line, so it is the current question, and there is more below.
  scrollTop = 300 * ROW;
  await new Promise((r) => requestAnimationFrame(r));
  rectReads = 0;
  fireEvent.scroll(viewport);
  await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('m300|true'));
  expect(rectReads).toBeLessThan(60);
});
