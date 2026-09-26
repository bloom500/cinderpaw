// FIRST, and deliberately above every other import: the storage-key migration
// has to run before any store module is evaluated, and an import is the only
// thing that can get ahead of `./App`'s own import graph. Calling it further
// down this file — which is what it used to do — runs it after every zustand
// store has already rehydrated. See `lib/bootStorage.ts`.
import './lib/bootStorage';

import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'framer-motion';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles/globals.css';

// Pre-paint theme: read persisted preference before React mounts to avoid a
// light-then-dark flash on cold start. See spec §3.2.
(() => {
  try {
    const stored = JSON.parse(localStorage.getItem('cinderpaw-ui') || '{}');
    const pref: string = stored?.state?.theme ?? 'dark';
    const resolved =
      pref === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
        : pref;
    document.documentElement.setAttribute('data-theme', resolved);
  } catch {
    // Unparseable persisted UI state. The theme falls back, but the value stays
    // broken for zustand's own rehydrate too — every boot silently loses the
    // user's settings again. Clear it once so the next start is clean.
    try { localStorage.removeItem('cinderpaw-ui'); } catch { /* storage unavailable */ }
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();

// The call pill is a second window on the same bundle: it renders the pill
// alone, over a transparent page, and talks to the app through events (see
// `lib/callPill.ts`).
const pill = window.location.hash === '#call-pill';
if (pill) {
  document.documentElement.classList.add('call-pill');
  // The startup surface is an opaque sheet held until the app mounts; over a
  // transparent window it is the rectangle around the pill (21 Sep).
  document.getElementById('cinderpaw-startup')?.remove();
}

const root = createRoot(document.getElementById('root')!);
const mount = (node: ReactNode) =>
  root.render(
    <StrictMode>
      <ErrorBoundary>
        {/* One line, at the root, for every `motion.*` element in the app.
            The canvas and sprite animations each read
            `prefers-reduced-motion` themselves — the orb, the mascot, the tool
            cards — but the dozen Framer components never did, so somebody who
            has asked their OS to stop moving things still got every panel
            sliding and every list staggering. `"user"` means the setting is
            theirs to make, which is the point: it is a default nobody sets in
            this app and it has to be right without being found. */}
        <MotionConfig reducedMotion="user">{node}</MotionConfig>
      </ErrorBoundary>
    </StrictMode>,
  );

// Each window loads only what it draws. The pill imported the whole app (2.7
// MB of script) to show one strip, every time a call was parked: 735 ms of
// script and 950 ms to its first pixel on a CPU slowed four times (25 Sep),
// on top of the webview starting. The app's own window pays one more local
// request for its chunk, under the startup sheet.
if (pill) void import('./components/call/CallPill').then(({ CallPill }) => mount(<CallPill />));
else void import('./App').then(({ default: App }) => mount(<App />));
