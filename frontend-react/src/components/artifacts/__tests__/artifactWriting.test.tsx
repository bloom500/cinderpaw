import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const events = vi.hoisted(() => new Map<string, Set<(event: { payload: { data: string } }) => void>>());
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, callback: (event: { payload: { data: string } }) => void) => {
    const listeners = events.get(name) ?? new Set();
    events.set(name, listeners);
    listeners.add(callback);
    return () => { listeners.delete(callback); };
  }),
}));
vi.mock('@/lib/cinderpawAgentStream', () => ({ ensureCinderpawListener: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/tauri', async (original) => {
  const actual = await original<typeof import('@/lib/tauri')>();
  return { ...actual, tauri: {
    ...actual.tauri,
    raw: { ...actual.tauri.raw, agentIsReady: vi.fn().mockResolvedValue(false), cinderpawGetModelConfig: vi.fn().mockResolvedValue(null) },
    artifacts: { ...actual.tauri.artifacts, op: vi.fn().mockResolvedValue(undefined) },
    google: { ...actual.tauri.google, status: vi.fn().mockResolvedValue(null) },
  } };
});
vi.mock('@/router', () => ({ router: { state: { location: { pathname: '/chat' } }, navigate: vi.fn() } }));

import { useCinderpawGlobal } from '@/hooks/useCinderpaw';
import { useArtifacts, resetArtifactRequests } from '@/stores/artifacts';
import { useChat } from '@/stores/chat';
import { ArtifactsPanel } from '../ArtifactsPanel';

beforeEach(() => {
  events.clear();
  resetArtifactRequests();
  useChat.setState({ sessionId: 'visual-test' });
  useArtifacts.setState({ open: null, editing: null });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const emit = (event: Record<string, unknown>) => {
  const data = JSON.stringify(event);
  for (const listener of events.get('cinderpaw://agent-output') ?? []) listener({ payload: { data } });
};
const emitDraft = () => emit({ type: 'artifact_draft', id: 'turn', sessionId: 'visual-test', draft: '0:0', append: 'Gradina' });
/** Pieces of writing are drawn on the next frame. */
const nextFrame = () => act(async () => { await new Promise((done) => requestAnimationFrame(() => done(null))); });

describe('global sidecar listener lifetime', () => {
  it('appends each draft chunk once after StrictMode replays the effect', async () => {
    renderHook(() => useCinderpawGlobal(), { wrapper: StrictMode });
    await act(async () => {});
    act(emitDraft);
    await nextFrame();
    expect(useArtifacts.getState().open?.content).toBe('Gradina');
    act(emitDraft);
    await nextFrame();
    expect(useArtifacts.getState().open?.content).toBe('GradinaGradina');
  });

  it('does not apply events after unmounting during asynchronous registration', async () => {
    const view = renderHook(() => useCinderpawGlobal());
    view.unmount();
    await act(async () => {});
    act(emitDraft);
    await nextFrame();
    expect(useArtifacts.getState().open).toBeNull();
  });

  it('draws the pieces of one frame as one, and lets nothing overtake them', async () => {
    renderHook(() => useCinderpawGlobal());
    await act(async () => {});
    act(() => { emitDraft(); emitDraft(); emitDraft(); });
    expect(useArtifacts.getState().open).toBeNull();
    // A turn that ends before the frame still finds every piece in place.
    act(() => emit({ type: 'done', id: 'turn' }));
    const open = useArtifacts.getState().open!;
    expect(open.content).toBe('GradinaGradinaGradina');
    expect(open.live!.runs).toHaveLength(1);
    expect(open.live!.stopped).toBe('Cinderpaw stopped before saving this.');
  });
});

describe('following a part written above the end of a document', () => {
  const part = (append: string) => useArtifacts.getState().onDraft({
    id: 'turn', sessionId: 'visual-test', draft: '1:0', editOf: 'garden', find: '[[First]]', append, onScreen: true,
  });
  function writingPanel(append = 'Grow') {
    const now = Date.now();
    useArtifacts.setState({
      loaded: true, panelTab: 'artifacts', busy: false, error: null, review: null, focus: null,
      open: {
        row: { id: 'garden', kind: 'markdown', title: 'Garden', version: 1, bytes: 100, updatedAt: now, modifiedBy: 'agent' },
        showing: 1, versions: [], content: '# Garden\n\n## First\n\n[[First]]\n\n## Last\n\n[[Last]]',
      },
    });
    part(append);
    // The placeholder has finished fading out and the letters written so far
    // have come in; the writing cursor is visible.
    vi.spyOn(Date, 'now').mockReturnValue(now + 5000);
    const scrollIntoView = vi.fn();
    const previous = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    const view = render(<ArtifactsPanel onClose={() => {}} />);
    return { ...view, scrollIntoView, restore: () => { HTMLElement.prototype.scrollIntoView = previous; } };
  }

  it('follows the writing cursor, rather than the placeholders at the document bottom', () => {
    const view = writingPanel();
    try {
      const caret = view.container.querySelector('.ember-caret');
      expect(caret).not.toBeNull();
      expect(view.scrollIntoView.mock.instances).toContain(caret);
    } finally { view.restore(); }
  });

  it('keeps the cursor at the last visible letter when a part ends with whitespace', () => {
    const view = writingPanel('Grow plants. \n\n');
    try {
      const caret = view.container.querySelector('.ember-caret');
      expect(caret).not.toBeNull();
      expect(caret?.parentElement?.textContent).toBe('Grow plants.');
      expect(view.scrollIntoView.mock.instances).toContain(caret);
    } finally { view.restore(); }
  });

  it('keeps following a visible part in the middle, and pauses when the reader scrolls away', () => {
    const view = writingPanel();
    try {
      const viewport = view.container.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]')!;
      Object.defineProperties(viewport, { scrollHeight: { value: 3000 }, clientHeight: { value: 400 } });
      vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 500 } as DOMRect);
      let caretTop = 300;
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        return { top: this.classList.contains('ember-caret') ? caretTop : 100, bottom: this.classList.contains('ember-caret') ? caretTop + 20 : 500 } as DOMRect;
      });
      viewport.scrollTop = 200;
      fireEvent.scroll(viewport);
      view.scrollIntoView.mockClear();
      act(() => part(' plants'));
      expect(view.scrollIntoView).toHaveBeenCalled();

      // The page moving by itself (a placeholder going) is not the reader leaving.
      caretTop = 900;
      fireEvent.scroll(viewport);
      view.scrollIntoView.mockClear();
      act(() => part(' slowly'));
      expect(view.scrollIntoView).toHaveBeenCalled();

      // The reader's own wheel is.
      fireEvent.wheel(viewport);
      fireEvent.scroll(viewport);
      view.scrollIntoView.mockClear();
      act(() => part(' carefully.'));
      expect(view.scrollIntoView).not.toHaveBeenCalled();
    } finally { view.restore(); }
  });
});
