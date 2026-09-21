import { useEffect, useRef } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { currentMonitor, getCurrentWindow, LogicalPosition, LogicalSize } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { CallPhase } from '@/hooks/useCallSession';

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
 */
export interface CallPillState {
  phase: CallPhase;
  heard: string;
  said: string;
  muted: boolean;
  /** False on an engine without a microphone switch; the pill says so. */
  canMute: boolean;
}

export const PILL_LABEL = 'call-pill';
const PILL_SIZE = { w: 560, h: 64 };

function onCall(phase: CallPhase): boolean {
  return phase !== 'idle' && phase !== 'ready';
}

async function openPill(): Promise<void> {
  if (await WebviewWindow.getByLabel(PILL_LABEL)) return;
  // Top-centre of the monitor the app is on, in logical pixels.
  const mon = await currentMonitor().catch(() => null);
  const scale = mon?.scaleFactor ?? 1;
  const width = (mon?.size.width ?? 1280) / scale;
  const left = (mon?.position.x ?? 0) / scale;
  const top = (mon?.position.y ?? 0) / scale;
  const x = Math.round(left + (width - PILL_SIZE.w) / 2);
  const pill = new WebviewWindow(PILL_LABEL, {
    url: '/#call-pill',
    title: 'Cinderpaw call',
    width: PILL_SIZE.w,
    height: PILL_SIZE.h,
    x,
    y: Math.round(top + 8),
    decorations: false,
    transparent: true,
    shadow: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focus: false,
  });
  await new Promise<void>((resolve) => {
    void pill.once('tauri://created', () => resolve());
    void pill.once('tauri://error', () => resolve());
  });
  // A monitor reported wrongly (or none): still keep it on screen.
  await pill.setSize(new LogicalSize(PILL_SIZE.w, PILL_SIZE.h)).catch(() => {});
  await pill.setPosition(new LogicalPosition(x, Math.round(top + 8))).catch(() => {});
}

async function closePill(): Promise<void> {
  const pill = await WebviewWindow.getByLabel(PILL_LABEL);
  await pill?.destroy().catch(() => {});
}

async function showMain(): Promise<void> {
  const main = getCurrentWindow();
  await main.show().catch(() => {});
  await main.unminimize().catch(() => {});
  await main.setFocus().catch(() => {});
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
  const state: CallPillState = {
    phase: call.phase,
    heard: call.heard,
    said: call.said ?? '',
    muted: call.muted ?? false,
    canMute: typeof call.setMuted === 'function',
  };
  // The handlers read the latest call through a ref: the listeners are
  // registered once per call, not once per render.
  const latest = useRef(call);
  latest.current = call;
  const stateRef = useRef(state);
  stateRef.current = state;

  // The pill mirrors the state whenever it changes.
  useEffect(() => {
    if (!active) return;
    void emit('call-pill://state', state);
    // The list is the state's fields: a new value in any of them is a new pill.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, state.phase, state.heard, state.said, state.muted, state.canMute]);

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    const main = getCurrentWindow();
    if (!active) {
      // No call: no pill, and a hidden window comes back.
      void (async () => {
        await closePill();
        if (!(await main.isVisible().catch(() => true))) await showMain();
      })();
      return;
    }
    const subs = [
      // Closing or minimising the app during a call parks it in the pill.
      main.onCloseRequested(async (e) => {
        e.preventDefault();
        await openPill();
        await main.hide().catch(() => {});
      }),
      main.onFocusChanged(async ({ payload: focused }) => {
        // Back in front: the pill has nothing to add. Minimised: it carries the call.
        if (focused) { await closePill(); return; }
        if (await main.isMinimized().catch(() => false)) await openPill();
      }),
      listen('call-pill://hello', () => { void emit('call-pill://state', stateRef.current); }),
      listen<{ muted: boolean }>('call-pill://mute', (e) => latest.current.setMuted?.(e.payload.muted)),
      listen('call-pill://interrupt', () => latest.current.interrupt()),
      listen('call-pill://end', () => latest.current.hangUp()),
      listen('call-pill://open', () => { void (async () => { await closePill(); await showMain(); })(); }),
    ];
    return () => { subs.forEach((s) => { void s.then((off) => off()); }); };
    // `state` is re-sent by the effect above; this one only needs the call's on/off.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
