# Update toast + correct version display — design

Date: 2026-05-31

## Problem

1. **Stale version label.** Settings shows "App version 0.1.0" even on the latest
   build. `settings.version` is a *persisted* field (`src-tauri/src/settings.rs`,
   `env!("CARGO_PKG_VERSION")` only as the `Default`). The value written to disk on
   the first 0.1.0 run is loaded forever after and never refreshed — so it diverges
   from the real binary version (which the updater compares correctly, hence the
   contradictory "Latest" badge).

2. **No proactive update notification.** The updater is only reachable via a manual
   "Check for updates" button in Settings, and `checkAndInstall` *force-installs*
   immediately when an update is found (no user choice).

## Goals

- Display the real running binary version, never a stale value.
- Notify the user proactively when an update is available, without forcing install.

## Design

### Part 1 — Correct version display

Use `getVersion()` from `@tauri-apps/api/app` (always reflects the current binary,
same source the updater compares) instead of `settings?.version` in
`GeneralTab.tsx` and `AboutTab.tsx`. The persisted backend `version` field is left
as-is but no longer displayed.

### Part 2 — Update toast + startup check

**Shared state — `stores/updater.ts` (zustand).** Replaces the per-component
`useUpdater` hook so the startup check, the toast, and both Settings tabs share one
state.

- State: `status: 'idle' | 'checking' | 'available' | 'downloading' | 'up-to-date' | 'error'`,
  `info: { version, notes } | null`, `progress: number`, `error: string | null`.
- Actions:
  - `check()` — runs `check()` from the updater plugin. If an update exists, stores
    `info` and sets `status='available'` (does **not** auto-install). If none, sets
    `up-to-date`. On failure, `error`. The startup caller treats `up-to-date`/`error`
    silently (no toast).
  - `install()` — `downloadAndInstall` with progress → `relaunch()`. Sets
    `status='downloading'` and updates `progress`.
  - `dismiss()` — returns status to `idle` (the "Later" action).

**Startup check.** `AppShell` runs `check()` once on mount via `useEffect`.

**`components/UpdateToast.tsx`.** Mounted in `AppShell`, fixed bottom-right. Visible
when `status === 'available' || 'downloading'`. Shows "✨ Update vX.Y.Z available",
1–2 lines of notes, `[Install]` and a dismiss `×`. On Install → inline progress bar
→ relaunch on finish. Does not overlap the top-right window controls.

**Settings.** `GeneralTab` / `AboutTab` consume the same store; their button calls
`check()`. The toast drives the install flow. The old auto-install behavior is
removed.

### Files

- New: `stores/updater.ts`, `components/UpdateToast.tsx`
- Edit: `hooks/useUpdater.ts` (thin re-export of the store, or removed),
  `GeneralTab.tsx`, `AboutTab.tsx`, `AppShell.tsx`
- Test: `stores/__tests__/updater.test.ts` — mocks `@tauri-apps/plugin-updater` and
  `@tauri-apps/plugin-process`; asserts `check()` → `available` with info, no update
  → `up-to-date`, error → `error`, and `dismiss()` → `idle`.

## Out of scope

- Changing the backend `Settings` struct.
- Periodic/background re-checks beyond the single startup check.
