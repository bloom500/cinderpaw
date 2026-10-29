import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Events from the host, deliverable from a test: `emitTauri(name, payload)`.
// Hoisted: the store listens at import, before this file's own lines run.
const listeners = vi.hoisted(() => new Map<string, Array<(e: { payload: unknown }) => void>>());
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    listeners.set(name, [...(listeners.get(name) ?? []), cb]);
    return () => {};
  },
  emit: async () => {},
}));
const emitTauri = (name: string, payload: unknown) =>
  act(() => { for (const cb of listeners.get(name) ?? []) cb({ payload }); });

vi.mock('@/lib/tauri', async (orig) => {
  const actual = await orig<typeof import('@/lib/tauri')>();
  return { ...actual, tauri: { ...actual.tauri, browser: { ui: vi.fn().mockResolvedValue({ ok: true }) } } };
});

import { PageQuestionDialog } from '../PageQuestionDialog';
import { applyHostState, useBrowser } from '@/stores/browser';
import { useNotifications } from '@/stores/notifications';
import { tauri } from '@/lib/tauri';

const ui = tauri.browser.ui as unknown as ReturnType<typeof vi.fn>;
const tab = (id: number) => ({ id, title: 'X', url: 'https://x.com/compose/post', loading: false, canBack: false, canForward: false, blocked: 0 });

beforeEach(() => {
  ui.mockClear();
  useBrowser.setState({ dialogs: [], tabs: [tab(1)], active: 1 });
  useNotifications.setState({ toasts: [] });
});
afterEach(cleanup);

describe("a page's own question", () => {
  it('asks "Leave site?" in the app, and Stay keeps the page', async () => {
    render(<PageQuestionDialog />);
    await emitTauri('browser://dialog', { id: 7, tab: 1, kind: 'leave', site: 'x.com', message: '', text: '' });
    expect(screen.getByText('Leave x.com?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
    expect(ui).toHaveBeenCalledWith('dialog_answer', { id: 7, ok: false, text: null });
    expect(screen.queryByText('Leave x.com?')).toBeNull();
  });

  it("answers a prompt with what the person typed, then shows the next question", async () => {
    render(<PageQuestionDialog />);
    await emitTauri('browser://dialog', { id: 1, tab: 1, kind: 'prompt', site: 'x.com', message: 'Your name?', text: 'Ana' });
    await emitTauri('browser://dialog', { id: 2, tab: 1, kind: 'alert', site: 'x.com', message: 'Saved.', text: '' });
    const box = screen.getByRole('textbox', { name: 'Answer to x.com' });
    expect(box).toHaveValue('Ana');
    fireEvent.change(box, { target: { value: 'Darius' } });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(ui).toHaveBeenCalledWith('dialog_answer', { id: 1, ok: true, text: 'Darius' });
    // An alert has nothing to cancel.
    expect(screen.getByText('Saved.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it("drops the question of a tab that closed", async () => {
    render(<PageQuestionDialog />);
    await emitTauri('browser://dialog', { id: 3, tab: 1, kind: 'confirm', site: 'x.com', message: 'Delete?', text: '' });
    expect(screen.getByText('Delete?')).toBeInTheDocument();
    act(() => applyHostState({ active: null, tabs: [] }));
    expect(screen.queryByText('Delete?')).toBeNull();
  });

  it('says on screen when a page with unsaved changes was left out of sight', async () => {
    await emitTauri('browser://left', { site: 'x.com', closed: false });
    const [toast] = useNotifications.getState().toasts;
    expect(toast?.title).toBe('Left x.com without saving');
    expect(toast?.message).toContain('like a draft');
    expect(toast?.sticky).toBe(true);
  });
});
