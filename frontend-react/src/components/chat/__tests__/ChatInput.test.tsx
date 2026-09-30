/**
 * ChatInput — what happens to the words someone typed when the send fails.
 *
 * The composer clears optimistically, because waiting for a whole turn before
 * the box empties feels broken. That means the typed message lives nowhere but
 * in a local const until a bubble carries it onto the transcript — so a send
 * that throws before that bubble exists loses it outright, and there was no
 * `catch` on the call either, so the failure was an unhandled rejection and the
 * screen said nothing at all.
 *
 * The rule these pin: the draft comes back only when nothing reached the
 * transcript. Once a user bubble exists the words are safe there, and putting
 * the draft back too would show them twice.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRef } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatInput } from '../ChatInput';
import { useChat } from '@/stores/chat';
import { useNotifications } from '@/stores/notifications';
import { useConversations } from '@/stores/conversations';

// Everything the composer mounts that talks to the OS, the microphone or a
// call. None of it participates in the send path under test.
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock('@/hooks/useVoiceRecorder', () => ({
  useVoiceRecorder: () => ({ state: 'idle', blob: null, durationMs: 0, error: null, start: vi.fn(), stop: vi.fn(), reset: vi.fn() }),
}));
// Inlined rather than shared through a const: vi.mock factories are hoisted
// above every top-level binding in the file.
const IDLE_CALL = {
  phase: 'idle', heard: '', level: 0, notice: null,
  open: () => {}, begin: () => {}, hangUp: () => {}, interrupt: () => {}, say: () => {},
};
vi.mock('@/hooks/useCallSession',        () => ({ useCallSession: () => IDLE_CALL, speak: () => {} }));
vi.mock('@/hooks/useLiveCallSession',    () => ({ useLiveCallSession: () => IDLE_CALL }));
vi.mock('@/hooks/useLiveKitCallSession', () => ({ useLiveKitCallSession: () => IDLE_CALL }));
vi.mock('@/hooks/useJevCallSession',      () => ({ useJevCallSession: () => IDLE_CALL }));
// The download store subscribes to host events when it is imported; there is no host here.
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('@/hooks/useSendMessage', () => ({
  useSendMessage: () => vi.fn(async () => {}),
  saveVoiceBlobToDisk: vi.fn(),
  transcribeVoiceBlob: vi.fn(),
  buildUserContent: (text: string) => text,
}));

// The campfire game and the perch: a mutable run the composer reads each render.
const ember = { offered: false, open: false, round: null, openPanel: () => {}, closePanel: () => {} };
vi.mock('../ember/useEmberRun', () => ({ useEmberRun: () => ember }));
vi.mock('../mascot/MascotPerch', () => ({ MascotPerch: () => <div data-testid="perch" /> }));

beforeEach(() => {
  vi.clearAllMocks();
  useChat.setState({ messages: [], streamStatus: 'idle' });
  useNotifications.setState({ toasts: [] });
  useConversations.setState({ currentId: null });
  window.localStorage.clear();
});

async function type(text: string) {
  const box = screen.getByRole('textbox');
  await userEvent.type(box, text);
  return box as HTMLTextAreaElement;
}

describe('a send that fails', () => {
  it('gives the message back when nothing reached the transcript', async () => {
    const sendFn = vi.fn(async () => { throw new Error('cinderpaw-agent is not running'); });
    render(<ChatInput alwaysEnabled sendFn={sendFn} />);

    const box = await type('the thing I spent a minute writing');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(box.value).toBe('the thing I spent a minute writing'));
    // And says so, on screen, rather than in a console nobody has open.
    await waitFor(() =>
      expect(
        useNotifications.getState().toasts.some((t) => t.kind === 'error' && t.title === 'Message not sent'),
      ).toBe(true),
    );
  });

  it('does NOT give it back when a bubble already carries it', async () => {
    // The usual shape: the user message lands on the transcript, then the
    // stream falls over. Restoring the draft here would show it twice.
    const sendFn = vi.fn(async (text: string) => {
      useChat.getState().addMessage({ id: 'u1', role: 'user', content: text, createdAt: Date.now() });
      throw new Error('stream died');
    });
    render(<ChatInput alwaysEnabled sendFn={sendFn} />);

    const box = await type('already on screen');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(sendFn).toHaveBeenCalled());
    expect(box.value).toBe('');
  });

  it('clears the box on the happy path', async () => {
    const sendFn = vi.fn(async () => {});
    render(<ChatInput alwaysEnabled sendFn={sendFn} />);

    const box = await type('hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(box.value).toBe(''));
    expect(useNotifications.getState().toasts).toHaveLength(0);
  });
});

// Files dropped from the OS arrive as HTML5 drop events: with `dragDropEnabled`
// off in tauri.conf.json Tauri emits nothing, and the browser app never had
// Tauri events. Without an HTML5 handler a drop did nothing at all (20 Sep).
describe('a file dropped on the composer', () => {
  it('is attached through the same helper as a paste', async () => {
    const attachments = await import('@/lib/attachments');
    const spy = vi.spyOn(attachments, 'attachmentsFromClipboard').mockResolvedValue([]);
    render(<ChatInput alwaysEnabled />);
    const composer = screen.getByRole('textbox').closest('[class*="rounded-[28px]"]') as HTMLElement;
    expect(composer).not.toBeNull();
    const dataTransfer = { types: ['Files'], items: [], files: [] } as unknown as DataTransfer;
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.dragOver(composer, { dataTransfer });
    // The words are ChatPage's one overlay now; the composer only marks its edge.
    expect(composer.className).toContain('border-dashed');
    fireEvent.drop(composer, { dataTransfer });
    await waitFor(() => expect(spy).toHaveBeenCalledWith(dataTransfer));
    expect(composer.className).not.toContain('border-dashed');
  });
});

describe('a pasted link', () => {
  it('becomes a chip in the composer and goes first in the message', async () => {
    const sendFn = vi.fn(async () => {});
    render(<ChatInput alwaysEnabled sendFn={sendFn} />);
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    await userEvent.click(box);
    await userEvent.paste('https://github.com/jd-opensource/JoyAI-Video-Edit');

    // A chip with the short name, and nothing typed into the box.
    expect(screen.getByText('jd-opensource/JoyAI-Video-Edit')).toBeTruthy();
    expect(box.value).toBe('');

    await userEvent.type(box, 'ce face asta?');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(sendFn).toHaveBeenCalled());
    expect((sendFn.mock.calls[0] as unknown[])[0]).toBe('https://github.com/jd-opensource/JoyAI-Video-Edit\nce face asta?');
    expect(screen.queryByText('jd-opensource/JoyAI-Video-Edit')).toBeNull();
  });

  it('stays text when it is part of a sentence', async () => {
    render(<ChatInput alwaysEnabled sendFn={vi.fn(async () => {})} />);
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    await userEvent.click(box);
    await userEvent.paste('vezi https://hotnews.ro/ceva-anume');
    expect(box.value).toBe('vezi https://hotnews.ro/ceva-anume');
  });

  it('comes back out with Backspace in an empty box', async () => {
    render(<ChatInput alwaysEnabled sendFn={vi.fn(async () => {})} />);
    const box = screen.getByRole('textbox');
    await userEvent.click(box);
    await userEvent.paste('https://github.com/a/b');
    expect(screen.getByText('a/b')).toBeTruthy();
    await userEvent.keyboard('{Backspace}');
    expect(screen.queryByText('a/b')).toBeNull();
  });
});

describe('a draft', () => {
  it('stays with its conversation across a switch', async () => {
    useConversations.setState({ currentId: 'c1' });
    render(<ChatInput alwaysEnabled sendFn={vi.fn()} />);
    const box = await type('half a sentence');

    act(() => useConversations.setState({ currentId: 'c2' }));
    await waitFor(() => expect(box.value).toBe(''));
    act(() => useConversations.setState({ currentId: 'c1' }));
    await waitFor(() => expect(box.value).toBe('half a sentence'));
  });

  it('does not wipe text typed in for the person as the chat switches (Teach)', async () => {
    const ref = createRef<{ setText: (t: string) => void }>();
    render(<ChatInput ref={ref as never} alwaysEnabled sendFn={vi.fn()} />);
    act(() => {
      useConversations.setState({ currentId: 'fresh' });
      ref.current!.setText('Teach me a skill');
    });
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Teach me a skill'));
  });
});

describe('a long paste', () => {
  const paste = (text: string) =>
    fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { getData: () => text, items: [] } });

  it('becomes a card instead of filling the box, and a click shows all of it', async () => {
    render(<ChatInput alwaysEnabled sendFn={vi.fn(async () => {})} />);
    const log = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    paste(log);

    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
    await userEvent.click(screen.getByRole('button', { name: 'Open Pasted text, 30 lines' }));
    expect(screen.getByText(/line 30/)).toBeTruthy();
  });

  it('a short paste stays text', () => {
    render(<ChatInput alwaysEnabled sendFn={vi.fn(async () => {})} />);
    paste('just a sentence');
    expect(screen.queryByRole('button', { name: /^Open Pasted text/ })).toBeNull();
  });
});


// 30 Sep: with the game open, the perch mascot kept walking the composer's edge
// right under the game and got in the way of play.
describe('the campfire game', () => {
  it('hides the perch mascot while the game is open, and brings it back after', () => {
    ember.open = true;
    const { rerender } = render(<ChatInput alwaysEnabled />);
    expect(screen.getByTestId('perch').closest('[hidden]')).not.toBeNull();
    ember.open = false;
    rerender(<ChatInput alwaysEnabled />);
    expect(screen.getByTestId('perch').closest('[hidden]')).toBeNull();
  });
});
