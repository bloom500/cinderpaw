import { useEffect } from 'react';
import { useChat } from '@/stores/chat';
import { useNotifications } from '@/stores/notifications';
import { useOnboarding } from '@/stores/onboarding';
import { useUI } from '@/stores/ui';
import { useSoundSettings } from '@/stores/sounds';
import { useCoworkTranscript } from '@/stores/coworkTranscript';
import { playUiSound, stopUiSound, unlockUiSounds } from '@/lib/uiSounds';

/** Subscribe once at the app root; history, rerenders and stops stay silent. */
export function useUiSounds(): void {
  useEffect(() => {
    const control = (event: Event) => {
      if (!(event.target instanceof Element)) return null;
      if (event.target.closest('[data-ui-sound="none"], [data-call-overlay]')) return null;
      const el = event.target.closest<HTMLElement>('button, input, [role="switch"], [role="checkbox"], [role="radio"]');
      return el && !el.matches(':disabled, [aria-disabled="true"]') ? el : null;
    };
    const unlock = () => unlockUiSounds();
    const click = (event: MouseEvent) => {
      const el = control(event);
      if (!el) return;
      // Native inputs are heard on `change`, where the new state is known.
      if (el.matches('input')) return;
      // Capture phase runs before React flips aria-checked, so "true" here means turning off.
      if (el.matches('[role="switch"], [role="checkbox"], [role="radio"]')) void playUiSound(el.getAttribute('aria-checked') === 'true' ? 'toggle-off' : 'toggle-on');
      else if (el.matches('button') && !el.hasAttribute('aria-haspopup') && (el.classList.contains('bg-brand') || el.classList.contains('bg-primary'))) void playUiSound('tap');
    };
    const change = (event: Event) => {
      const el = control(event);
      if (el instanceof HTMLInputElement && el.matches('[type="checkbox"], [type="radio"]')) void playUiSound(el.checked ? 'toggle-on' : 'toggle-off');
    };
    const menu = (event: Event) => {
      const el = control(event);
      if (el?.hasAttribute('aria-haspopup') && el.getAttribute('aria-expanded') !== 'true' && el.getAttribute('data-state') !== 'open') void playUiSound('panel-open');
    };
    const key = (event: KeyboardEvent) => {
      unlock();
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') menu(event);
    };
    document.addEventListener('pointerdown', unlock, true);
    document.addEventListener('pointerdown', menu, true);
    document.addEventListener('keydown', key, true);
    document.addEventListener('click', click, true);
    document.addEventListener('change', change, true);
    const releases = [
      useChat.subscribe((state, prev) => {
        if (state.sessionId !== prev.sessionId) return;
        if (state.streamStatus === 'done' && prev.streamStatus === 'streaming' && !state.lastCompletionStopped) void playUiSound('task-done');
        if (state.streamStatus === 'error' && prev.streamStatus !== 'error') void playUiSound('error');
        if (state.messages.length === prev.messages.length + 1 && state.messages.slice(0, -1).every((m, i) => m === prev.messages[i]) && state.messages.at(-1)?.role === 'user') void playUiSound('message-send');
      }),
      useNotifications.subscribe((state, prev) => {
        const toast = state.toasts.at(-1);
        if (!toast || prev.toasts.some((t) => t.id === toast.id)) return;
        if (toast.kind === 'error') void playUiSound('error');
        else if (toast.kind === 'success') void playUiSound('task-done');
        else if (toast.action) void playUiSound('notification');
      }),
      useOnboarding.subscribe((state, prev) => {
        if (!prev.active || state.active || prev.hasOnboardedBefore || !state.hasOnboardedBefore || state.skipped) return;
        try {
          if (localStorage.getItem('cinderpaw.audioLogoPlayed')) return;
          localStorage.setItem('cinderpaw.audioLogoPlayed', 'true');
        } catch { /* first-run transition still prevents repeats this launch */ }
        void playUiSound('audio-logo');
      }),
      useUI.subscribe((state, prev) => {
        if ((state.searchOpen && !prev.searchOpen) || (state.skillsOpen && !prev.skillsOpen) || (state.navCollapsed !== prev.navCollapsed && !state.navCollapsed)) void playUiSound('panel-open');
        else if ((!state.searchOpen && prev.searchOpen) || (!state.skillsOpen && prev.skillsOpen) || (state.navCollapsed && !prev.navCollapsed)) void playUiSound('panel-close');
      }),
      useSoundSettings.subscribe((state) => { if (!state.enabled || state.volume <= 0) stopUiSound(); }),
      useCoworkTranscript.subscribe((state, prev) => {
        for (const exchange of state.exchanges) {
          if (exchange.kind !== 'approval') continue;
          const before = prev.exchanges.find((e) => e.id === exchange.id);
          if (!before && exchange.status === 'running') void playUiSound('notification');
          else if (before?.status === 'running' && exchange.outcome === 'approved' && exchange.status === 'done') void playUiSound('tool-approved');
        }
      }),
    ];
    return () => {
      document.removeEventListener('pointerdown', unlock, true);
      document.removeEventListener('pointerdown', menu, true);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('click', click, true);
      document.removeEventListener('change', change, true);
      releases.forEach((release) => release());
      stopUiSound();
    };
  }, []);
}
