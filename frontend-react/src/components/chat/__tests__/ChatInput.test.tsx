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
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatInput } from '../ChatInput';
import { useChat } from '@/stores/chat';
import { useNotifications } from '@/stores/notifications';

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
vi.mock('@/hooks/useSendMessage', () => ({
  useSendMessage: () => vi.fn(async () => {}),
  saveVoiceBlobToDisk: vi.fn(),
  transcribeVoiceBlob: vi.fn(),
  buildUserContent: (text: string) => text,
}));

beforeEach(() => {
  vi.clearAllMocks();
  useChat.setState({ messages: [], streamStatus: 'idle' });
  useNotifications.setState({ toasts: [] });
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
