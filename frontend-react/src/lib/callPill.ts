import { useEffect, useRef } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { invoke } from '@tauri-apps/api/core';
import type { CallPhase } from '@/hooks/useCallSession';
import { useAskUser, type AskUserQuestion } from '@/stores/askUser';

/**
 * The call pill: a small always-on-top window at the top of the screen that
 * carries a voice call while the main window is out of the way.
 *
 * While a call is on, X and minimise do not end the app: the main window
 * hides and the pill appears, with the transcript and the three controls
 * (mute, stop the answer, end). When the call ends for any reason and the
 * window is hidden, the window comes back on its own: there is no tray icon,
 * so a hidden app with no pill would have no way back in.
 *
 * The two windows talk over Tauri events, which reach every window:
 *   main -> pill  `call-pill://state`   { phase, heard, said, muted }
 *   pill -> main  `call-pill://hello`   (the pill mounted, send the state)
 *                 `call-pill://mute`    { muted }
 *                 `call-pill://interrupt`
 *                 `call-pill://end`
 *                 `call-pill://open`    (bring the main window back)
 *                 `call-pill://answer`  { id, selected } (a question answered on the pill)
 */
export interface CallPillState {
  phase: CallPhase;
  heard: string;
  said: string;
  muted: boolean;
  /** False on an engine without a microphone switch; the pill says so. */
  canMute: boolean;
  /**
   * The question the agent is waiting on, if any. One question travels; a
   * form of several is a thing to look at, and the pill offers the app
   * instead (`questions` is the count).
   */
  ask: { id: string; question: AskUserQuestion; questions: number } | null;
}


/** True while the main window is hidden behind the pill or minimised: actions then target the desktop, not the app. */
export const parked = { current: false };
/**
 * True while the window is being parked: from the X (or the minimise) until
 * the pill is built. A focus event can land in that gap, and building the
 * pill handed the focus back to the window, which read as "back in front, no
 * pill needed" and retired the pill it had just been given (21 Sep). Outside
 * the gap the window itself is asked, so a window shown by anything else
 * (the app's icon clicked again, a deep link) still retires the pill.
 */
const parking = { current: false };

function onCall(phase: CallPhase): boolean {
  return phase !== 'idle' && phase !== 'ready';
}

/**
 * The window itself is built by the host (`call_pill_open`): a webview window
 * created from JS is not registered under the multiwebview feature the
 * browser needs, so nothing could reach it and it painted opaque (21 Sep).
 */
/** True when the pill is on screen; false means the main window must stay. */
async function openPill(why: string, state?: CallPillState): Promise<boolean> {
  console.info(`[pill] open: ${why}`);
  try {
    await invoke('call_pill_open');
  } catch (e) {
    console.warn('[pill] could not open', e);
    return false;
  }
  // The window is kept between calls (hidden, not destroyed), so a re-shown
  // pill still holds the last call's state until told otherwise.
  if (state) await emit('call-pill://state', state).catch(() => {});
  void describePill('opened');
  return true;
}

/**
 * Whether the host has the pill window, is it visible and where, in the
 * console. The pill's page runs in a window nobody can open the console of;
 * this line is what separated "not painted" from "not there" (21 Sep). A
 * timer that re-checked 2 s later and showed the window when the pill was
 * gone fired during the NEXT park, while its pill was still being built, and
 * brought the window back on top of it: no timers here.
 */
async function describePill(when: string): Promise<void> {
  try {
    const pill = await WebviewWindow.getByLabel('call-pill');
    if (!pill) { console.info(`[pill] ${when}: no window`); return; }
    const [visible, pos, size] = await Promise.all([pill.isVisible(), pill.outerPosition(), pill.outerSize()]);
    console.info(`[pill] ${when}: visible=${visible} at ${pos.x},${pos.y} size ${size.width}x${size.height}`);
  } catch (e) {
    console.info(`[pill] ${when}: state unknown`, e);
  }
}

async function closePill(why: string): Promise<void> {
  // Every retirement names its reason: a pill that vanished for no reason
  // anyone could see cost a day (21 Sep).
  console.info(`[pill] close: ${why}`);
  await invoke('call_pill_close').catch(() => {});
}

async function showMain(): Promise<void> {
  parked.current = false;
  const main = getCurrentWindow();
  await main.show().catch(() => {});
  await main.unminimize().catch(() => {});
  await main.setFocus().catch(() => {});
}

/**
 * The call is over: nothing is parked any more, and a hidden window comes
 * back, since it has no other way back (no tray icon). A minimised one stays
 * where the person put it: the call ending is no reason to jump in front of
 * whatever they are doing.
 */
async function releaseWindow(main: ReturnType<typeof getCurrentWindow>): Promise<void> {
  const hidden = parking.current || !(await main.isVisible().catch(() => true));
  parked.current = false;
  if (hidden) await showMain();
}

/**
 * Mounted once, beside the call engine, in the main window. `call` is the
 * engine's live state; `setMuted` is absent on engines without a switch.
 */
export function useCallPill(call: {
  phase: CallPhase;
  heard: string;
  said?: string;
  muted?: boolean;
  setMuted?: (m: boolean) => void;
  interrupt: () => void;
  hangUp: () => void;
}) {
  // The browser app and the tests have no host window: nothing to park, nothing to open.
  const active = onCall(call.phase) && '__TAURI_INTERNALS__' in window;
  const pendingAsk = useAskUser((s) => s.pending);
  const state: CallPillState = {
    phase: call.phase,
    heard: call.heard,
    said: call.said ?? '',
    muted: call.muted ?? false,
    canMute: typeof call.setMuted === 'function',
    ask: pendingAsk ? { id: pendingAsk.id, question: pendingAsk.questions[0], questions: pendingAsk.questions.length } : null,
  };
  // The handlers read the latest call through a ref: the listeners are
  // registered once per call, not once per render.
  const latest = useRef(call);
  latest.current = call;
  const stateRef = useRef(state);
  stateRef.current = state;
  /**
   * Whether the call is still on, read after an await. A call that ended while
   * its pill was being built had its cleanup run first, find no window to
   * close, and leave the pill to appear afterwards: always on top, its buttons
   * heard by nobody, and a close asked of it refused by design.
   */
  const activeRef = useRef(active);
  activeRef.current = active;

  // The pill mirrors the state whenever it changes.
  useEffect(() => {
    if (!active) return;
    void emit('call-pill://state', state).then(() => console.info('[pill] state sent', state.phase)).catch((e) => console.warn('[pill] state not sent', e));
    // The list is the state's fields: a new value in any of them is a new pill.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, state.phase, state.heard, state.said, state.muted, state.canMute, state.ask?.id]);

  // Whatever unmounts this bridge (a route change, a hot reload in dev) must
  // not leave the window hidden with no pill: that reads as the app having
  // quit (21 Sep). The pill goes, the window comes back.
  useEffect(() => () => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    void (async () => {
      await closePill('bridge unmounted');
      await releaseWindow(getCurrentWindow());
    })();
  }, []);

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    const main = getCurrentWindow();
    if (!active) {
      // No call: no pill, and a hidden window comes back.
      void (async () => {
        await closePill('call ended');
        await releaseWindow(main);
      })();
      return;
    }
    const subs = [
      // Closing or minimising the app during a call parks it in the pill.
      main.onCloseRequested(async (e) => {
        e.preventDefault();
        // Hidden first, the pill second. Built while the window was still on
        // screen, the new pill handed the focus back to the window, and the
        // focus handler below read "visible and in front: no pill needed" and
        // destroyed the pill it had just been given; the hide then followed,
        // and the app was gone with no pill and no way back (21 Sep). With the
        // window already hidden, that handler has nothing to close.
        parking.current = true;
        parked.current = true;
        try {
          await main.hide().catch(() => {});
          // No pill, no parking: the window comes back where it can be seen.
          if (!(await openPill('X pressed', stateRef.current))) await showMain();
          else if (!activeRef.current) {
            await closePill('call ended while parking');
            await showMain();
          }
        } finally {
          parking.current = false;
        }
      }),
      main.onFocusChanged(async ({ payload: focused }) => {
        // Back in front: the pill has nothing to add. Minimised: it carries the call.
        // A hidden window gets "focused" too, when a child webview inside it takes
        // the focus (the browser panel restoring its tabs, 21 Sep): that closed
        // the pill and left the app hidden with no way back. Only a window the
        // person can see retires the pill.
        if (parking.current) return;
        if (focused) {
          // Minimised counts as out of sight: Windows calls a minimised
          // window visible, and can hand it the focus without restoring it,
          // which retired the pill a minimise had just opened.
          const [visible, minimized] = await Promise.all([main.isVisible().catch(() => true), main.isMinimized().catch(() => false)]);
          if (visible && !minimized) { parked.current = false; await closePill('window back in front'); }
          return;
        }
        // Minimised is parked too: a command then acts on the desktop, not on
        // a browser panel nobody can see. (Only the hide path set this before,
        // so "open youtube" from a minimised app opened it in the hidden panel.)
        if (await main.isMinimized().catch(() => false)) {
          parking.current = true;
          parked.current = true;
          try {
            if ((await openPill('minimised', stateRef.current)) && !activeRef.current) {
              parked.current = false;
              await closePill('call ended while parking');
            }
          } finally {
            parking.current = false;
          }
        }
      }),
      listen('call-pill://hello', () => {
        void emit('call-pill://state', stateRef.current);
        void describePill('hello received');
      }),
      listen<{ muted: boolean }>('call-pill://mute', (e) => latest.current.setMuted?.(e.payload.muted)),
      listen('call-pill://interrupt', () => latest.current.interrupt()),
      listen('call-pill://end', () => latest.current.hangUp()),
      // The window first, the pill after: closing waits for the destroy to
      // land (up to a second), and a person who pressed Open is waiting too.
      listen('call-pill://open', () => { void (async () => { await showMain(); await closePill('open pressed'); })(); }),
      listen<{ id: string; selected: string[] }>('call-pill://answer', (e) => {
        const p = useAskUser.getState().pending;
        if (!p || p.id !== e.payload.id) return;
        useAskUser.getState().submit([{ question: p.questions[0].question, selected: e.payload.selected }]);
      }),
    ];
    return () => { subs.forEach((s) => { void s.then((off) => off()); }); };
    // `state` is re-sent by the effect above; this one only needs the call's on/off.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}

/**
 * Lives here, not in ChatInput.tsx: a component file that also exports a plain
 * function cannot be hot-reloaded by Vite, so every edit to anything it imports
 * remounted ChatInput, which killed the live call and the pill (21 Sep).
 *
 * Where the red X takes you. During a call it ends the call and leaves you on
 * the call screen, one press from calling again; only on that screen does it
 * leave for the chat. It used to drop you in the chat from the middle of a call,
 * so hanging up and calling back cost a trip through the composer (17 Sep).
 */
export function hangUpLandsOn(phase: string): 'ready' | 'idle' {
  return phase === 'ready' || phase === 'idle' ? 'idle' : 'ready';
}
