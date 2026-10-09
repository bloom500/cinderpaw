import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useUiSounds } from '../useUiSounds';
import { useChat } from '@/stores/chat';
import { useOnboarding } from '@/stores/onboarding';
import { useNotifications } from '@/stores/notifications';
import { useCoworkTranscript } from '@/stores/coworkTranscript';
import { playUiSound } from '@/lib/uiSounds';

vi.mock('@/lib/tauri', () => ({ tauri: {} }));
vi.mock('@/lib/uiSounds', () => ({ playUiSound: vi.fn(async () => true), stopUiSound: vi.fn(), unlockUiSounds: vi.fn() }));

describe('UI sound events', () => {
  beforeEach(() => {
    localStorage.removeItem('cinderpaw.audioLogoPlayed');
    useChat.setState({ sessionId: 'current', streamStatus: 'idle', lastCompletionStopped: false, messages: [] });
    useOnboarding.setState({ active: false, hasOnboardedBefore: false, skipped: false });
    useNotifications.setState({ toasts: [] });
    useCoworkTranscript.setState({ exchanges: [] });
    vi.clearAllMocks();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('sounds on natural completion, but not stop or history loaded into another session', () => {
    renderHook(() => useUiSounds());
    act(() => useChat.setState({ streamStatus: 'streaming' }));
    act(() => useChat.setState({ streamStatus: 'stopped' }));
    expect(playUiSound).not.toHaveBeenCalled();
    act(() => useChat.setState({ streamStatus: 'streaming' }));
    act(() => useChat.setState({ streamStatus: 'done', sessionId: 'history' }));
    expect(playUiSound).not.toHaveBeenCalled();
    act(() => useChat.setState({ streamStatus: 'streaming' }));
    act(() => useChat.setState({ streamStatus: 'done' }));
    expect(playUiSound).toHaveBeenCalledWith('task-done');
  });
  it('plays the audio logo once on first completed onboarding, never on skip or reopen', () => {
    renderHook(() => useUiSounds());
    act(() => useOnboarding.setState({ active: true }));
    act(() => useOnboarding.setState({ active: false, hasOnboardedBefore: true }));
    expect(playUiSound).toHaveBeenCalledWith('audio-logo');
    vi.clearAllMocks();
    act(() => useOnboarding.setState({ active: true }));
    act(() => useOnboarding.setState({ active: false }));
    expect(playUiSound).not.toHaveBeenCalled();
  });
  it('does not treat skipping onboarding as completion', () => {
    renderHook(() => useUiSounds());
    act(() => useOnboarding.setState({ active: true }));
    act(() => useOnboarding.setState({ active: false, hasOnboardedBefore: true, skipped: true }));
    expect(playUiSound).not.toHaveBeenCalled();
  });
  it('plays send once for a new user message, not for streamed reply updates', () => {
    renderHook(() => useUiSounds());
    const user = { id: 'u1', role: 'user' as const, content: 'Hello', createdAt: 1 };
    act(() => useChat.getState().addMessage(user));
    expect(playUiSound).toHaveBeenCalledWith('message-send');
    vi.clearAllMocks();
    act(() => useChat.getState().addMessage({ id: 'a1', role: 'assistant', content: '', createdAt: 2 }));
    act(() => useChat.getState().appendToStreamingAssistant('Hi'));
    expect(playUiSound).not.toHaveBeenCalled();
  });
  it('sounds approval only after the running request is confirmed approved', () => {
    const request = { id: 'approval:1', threadId: 'current', kind: 'approval' as const, fromAgentId: 'a', toAgentId: 'human', requestText: 'Send', responseText: null, status: 'running' as const, at: Date.now() };
    useCoworkTranscript.setState({ exchanges: [request] });
    renderHook(() => useUiSounds());
    act(() => useCoworkTranscript.setState({ exchanges: [{ ...request, status: 'error', outcome: 'denied' }] }));
    expect(playUiSound).not.toHaveBeenCalledWith('tool-approved');
    act(() => useCoworkTranscript.setState({ exchanges: [request] }));
    act(() => useCoworkTranscript.setState({ exchanges: [{ ...request, status: 'done', outcome: 'approved' }] }));
    expect(playUiSound).toHaveBeenCalledWith('tool-approved');
  });
  it('ignores disabled buttons, audition controls and non-primary buttons', () => {
    renderHook(() => useUiSounds());
    for (const html of ['<button disabled class="bg-brand">Save</button>', '<div data-ui-sound="none"><button class="bg-brand">Listen</button></div>', '<button>Cancel</button>']) {
      const el = document.createElement('div'); el.innerHTML = html; document.body.append(el);
      el.querySelector('button')!.click(); el.remove();
    }
    expect(playUiSound).not.toHaveBeenCalled();
  });
  it('a switch sounds on when it turns on and off when it turns off, once per flip', () => {
    renderHook(() => useUiSounds());
    const box = document.createElement('input'); box.type = 'checkbox'; box.setAttribute('role', 'switch'); document.body.append(box);
    box.click();
    expect(playUiSound).toHaveBeenCalledExactlyOnceWith('toggle-on');
    vi.clearAllMocks();
    box.click();
    expect(playUiSound).toHaveBeenCalledExactlyOnceWith('toggle-off');
    box.remove();
    const sw = document.createElement('button'); sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', 'true'); document.body.append(sw);
    vi.clearAllMocks();
    sw.click();
    expect(playUiSound).toHaveBeenCalledExactlyOnceWith('toggle-off');
    sw.remove();
  });
  it('removes listeners and subscriptions on unmount', () => {
    const { unmount } = renderHook(() => useUiSounds());
    unmount();
    act(() => useChat.setState({ streamStatus: 'error' }));
    const el = document.createElement('button'); el.className = 'bg-brand'; document.body.append(el); el.click(); el.remove();
    expect(playUiSound).not.toHaveBeenCalled();
  });
});
