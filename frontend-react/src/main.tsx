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
import { startFrameLog } from './lib/frameLog';
// Import through Vite so font URLs resolve relative to the package's CSS.
// Tailwind's CSS import inlining otherwise leaves bare ./files URLs in dist.
import '@fontsource-variable/geist';
import './styles/globals.css';

// The first frame's theme is stamped by public/cinderpaw-prepaint.js, which runs
// before this module and follows the OS when nothing is stored. This block used
// to stamp it a second time with a fallback of dark, so a light-mode stranger
// saw light, dark, then light again. What stays is the cleanup: unparseable
// persisted UI state is broken for zustand's own rehydrate too, and every boot
// would silently lose the user's settings again. Clear it once so the next
// start is clean.
(() => {
  try {
    JSON.parse(localStorage.getItem('cinderpaw-ui') || '{}');
  } catch {
    try { localStorage.removeItem('cinderpaw-ui'); } catch { /* storage unavailable */ }
  }
})();

// The call pill is a second window on the same bundle: it renders the pill
// alone, over a transparent page, and talks to the app through events (see
// `lib/callPill.ts`).
const pill = window.location.hash === '#call-pill';
// The browser's downloads card is the same kind of window (downloads_card.rs).
const downloadsCard = window.location.hash === '#downloads-card';
if (pill || downloadsCard) {
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

startFrameLog();

// Each window loads only what it draws. The pill imported the whole app (2.7
// MB of script) to show one strip, every time a call was parked: 735 ms of
// script and 950 ms to its first pixel on a CPU slowed four times (25 Sep),
// on top of the webview starting. The app's own window pays one more local
// request for its chunk, under the startup sheet. The downloads card is the
// same kind of small window, so it loads the same way.
if (pill) void import('./components/call/CallPill').then(({ CallPill }) => mount(<CallPill />));
else if (downloadsCard) void import('./components/browser/DownloadsPopup').then(({ DownloadsPopup }) => mount(<DownloadsPopup />));
else void import('./App').then(({ default: App }) => mount(<App />));
