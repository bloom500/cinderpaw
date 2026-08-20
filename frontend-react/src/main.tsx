import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles/globals.css';

// Pre-paint theme: read persisted preference before React mounts to avoid a
// light-then-dark flash on cold start. See spec §3.2.
(() => {
  try {
    const stored = JSON.parse(localStorage.getItem('feral-ui') || '{}');
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
    try { localStorage.removeItem('feral-ui'); } catch { /* storage unavailable */ }
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

