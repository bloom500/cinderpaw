# Feral React Migration — Spec 4: Settings Page + BYOK

**Date:** 2026-05-29
**Status:** Awaiting user review
**Branch:** `react-migration-spec1` (continues from spec 2)
**Depends on:** Spec 1 (foundation, IPC façade, stores), Spec 2 (systemInfo store)

This spec migrates the Leptos Settings page to React and adds the BYOK (Bring Your Own Key) cloud provider configuration that was deferred from Spec 2. Scope: all six settings categories + BYOK tab, settings Zustand store, file picker for data folder, sidebar link activation.

---

## 1. Architecture

### 1.1 New files

```
frontend-react/src/
├── pages/
│   └── SettingsPage.tsx              # shell: sidebar nav + active tab mount
├── components/settings/
│   ├── GeneralTab.tsx                # version, language, data folder, logs
│   ├── AppearanceTab.tsx             # theme segmented control
│   ├── HardwareTab.tsx               # GPU toggle, slider, HW info card, save
│   ├── ApiServerTab.tsx              # enable toggle, port, URL copy, save
│   ├── ByokTab.tsx                   # cloud providers accordion
│   ├── PrivacyTab.tsx                # static pledge card + bullet list
│   └── AboutTab.tsx                  # static version + GitHub links
└── stores/
    └── settings.ts                   # NEW: settings + byok state, fetch, save
```

### 1.2 Modified files

- `frontend-react/src/router.tsx` — `/settings` → `<SettingsPage />`
- `frontend-react/src/components/layout/Sidebar.tsx` — Settings item `disabled: false`
- `frontend-react/src/lib/tauri/index.ts` — add `ByokProvider` type; update `raw.getByokSettings` return type from `object[]` to `ByokProvider[]`

### 1.3 Data flow

```
SettingsPage mount
  → store.fetchSettings()  → tauri.settings.get()   → store.settings
  → store.fetchByok()      → tauri.raw.getByokSettings() → store.byok[]

Tab reads    → useSettings(s => s.settings)
Tab updates  → store.updateSettings(patch)   (local, no IPC)
Tab saves    → store.save()                  → tauri.settings.save()

BYOK save    → store.saveByokProvider(p)     → tauri.raw.saveByokProvider()
BYOK test    → store.testByokProvider(p)     → tauri.raw.testByokProvider()
```

`systemInfo.ts` (existing from Spec 2) is reused directly in `HardwareTab` — no duplication.

---

## 2. New store: `settings.ts`

```ts
import { create } from 'zustand';
import { tauri, type Settings, type ByokProvider } from '@/lib/tauri';

export interface ByokProviderUpdate {
  providerId: string;
  enabled: boolean;
  apiKey: string;
  baseUrl?: string | null;
  defaultModel?: string | null;
}

export interface ByokTestPayload {
  providerId: string;
  apiKey: string;
  baseUrl?: string | null;
}

export interface ByokTestResult { ok: boolean; error?: string }

interface SettingsStore {
  settings: Settings | null;
  byok: ByokProvider[];
  loading: boolean;
  saving: boolean;
  saved: boolean;

  fetchSettings: () => Promise<void>;
  fetchByok: () => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => void;
  save: () => Promise<void>;
  saveByokProvider: (p: ByokProviderUpdate) => Promise<void>;
  testByokProvider: (p: ByokTestPayload) => Promise<ByokTestResult>;
}
```

**Behaviour notes:**
- Store is **not** persisted (settings are authoritative in Tauri/`~/.feral/settings.json`)
- `updateSettings` is optimistic-local only — no IPC call
- `save` sets `saving: true`, calls `tauri.settings.save()`, then sets `saved: true` and schedules `saved: false` after 2 s via `setTimeout`
- `saveByokProvider` calls `tauri.raw.saveByokProvider()` then re-fetches byok state
- `testByokProvider` calls `tauri.raw.testByokProvider()` and returns the result; error handling is in the component

---

## 3. New types in `lib/tauri/index.ts`

```ts
export interface ByokProvider {
  id: string;
  name: string;
  enabled: boolean;
  api_key: string;        // arrives masked from backend (e.g. "sk-...****")
  base_url?: string | null;
  default_model?: string | null;
}
```

`ByokProviderUpdate`, `ByokTestPayload`, `ByokTestResult` live in `stores/settings.ts` (not IPC layer, they're store-internal).

---

## 4. Tab designs

### 4.1 SettingsPage shell

Thin component. Owns only `activeTab` state (string, default `'general'`). Calls `fetchSettings()` + `fetchByok()` on mount. Renders:
- Left sidebar with category buttons
- Right panel mounting the active tab component

Categories in order: General, Appearance, Hardware, API Server, BYOK, Privacy, About.

### 4.2 GeneralTab

| Row | Control | Behaviour |
|-----|---------|-----------|
| App version | Read-only text + "Check for updates" button | Button disabled (coming soon) |
| Language | `<select>` English / Română | Local state only — no persistence in `Settings` struct yet |
| Data folder | Path display + "Change" + "Open" buttons | "Change" → `@tauri-apps/plugin-dialog` `open({ directory: true })` → `updateSettings({ models_dir })` → `save()` |
| App logs | "Open logs" button | Opens `~/.feral` in OS file explorer via `open()` from `@tauri-apps/plugin-shell` (already installed) |

### 4.3 AppearanceTab

Segmented control: **Dark / Light / System**.

Reads `useUI(s => s.theme)`, writes `useUI.getState().setTheme(t)`. Does **not** touch `settings.ts` store — theme is already persisted in `ui.ts` via zustand/persist.

### 4.4 HardwareTab

| Row | Control | Behaviour |
|-----|---------|-----------|
| GPU acceleration | Toggle switch | `updateSettings({ default_gpu_layers: on ? 100 : 0 })` |
| GPU usage | Slider 0–100 + percentage label | `updateSettings({ default_gpu_layers: val })` |
| HW info card | GPU name + VRAM, RAM, CPU | `useSystemInfo()` from existing `stores/systemInfo.ts` |
| — | "Save" button + "✓ Saved" toast | `store.save()` |

Toggle and slider are linked: toggling off sets slider to 0, toggling on sets slider to 100.

### 4.5 ApiServerTab

| Row | Control | Behaviour |
|-----|---------|-----------|
| Enable API server | Toggle switch | `updateSettings({ api_server_enabled })` |
| Port | Number input (1024–65535) | `updateSettings({ api_port })` |
| Format | Static label | "Ollama-compatible + OpenAI-compatible" |
| API URL | Readonly input + "Copy" button | Clipboard API, 1.5 s "Copied ✓" feedback |
| — | "Save" button + "✓ Saved" toast | `store.save()` |

### 4.6 ByokTab

**Provider list** (hardcoded order in UI, merged with backend state):

```ts
const BYOK_PROVIDERS = [
  { id: 'openai',    name: 'OpenAI',          hasBaseUrl: true  },
  { id: 'anthropic', name: 'Anthropic',       hasBaseUrl: false },
  { id: 'gemini',    name: 'Google Gemini',   hasBaseUrl: false },
  { id: 'groq',      name: 'Groq',            hasBaseUrl: false },
  { id: 'mistral',   name: 'Mistral',         hasBaseUrl: false },
  { id: 'custom',    name: 'Custom Endpoint', hasBaseUrl: true  },
]
```

**Collapsed row:** provider name + badge ("Active" / "Not configured").

**Expanded panel per provider:**
- Enabled toggle
- API Key input (`type="password"` + show/hide eye button)
- Base URL input (only if `hasBaseUrl: true`)
- Default model input (text, optional)
- "Test" button → `store.testByokProvider()` → inline "✓ Connected" or error message
- "Save" button → `store.saveByokProvider()` → re-fetches byok, inline "✓ Saved"

Save and Test are **per-provider** — no global save button on the tab.

Uses `shadcn/ui Collapsible` (already installed). API key never shown on collapsed row.

### 4.7 PrivacyTab

Static. Privacy pledge card (icon + title + description) + bullet list:
- All conversations stored locally only
- Models stored locally only
- No background network requests
- Cloud providers (BYOK) only contacted when you explicitly send a message

No IPC calls.

### 4.8 AboutTab

Static. App name + version from `settings.version`. Built-by line. Two links: "View on GitHub →" and "Report an issue →". No IPC calls.

---

## 5. Sidebar + router wiring

**`router.tsx`:** Replace `<StubPage title="Settings" ... />` with `<SettingsPage />`.

**`Sidebar.tsx`:** Change Settings menu item from `disabled: true` to `disabled: false`. Remove the lock icon for this entry.

---

## 6. Error handling

- `fetchSettings` / `fetchByok` failures: store logs to console, settings remain `null`, tabs show a "Failed to load — retry" inline message
- `save` failure: toast shows "Save failed" instead of "✓ Saved", `saved` stays false
- `testByokProvider` failure / non-ok result: inline error below the Test button, no toast
- File picker cancellation (user dismisses dialog): no-op, current path unchanged
- Port input: validated client-side to 1024–65535 range before save

---

## 7. Out of scope

- Update checker (General tab button stays disabled)
- Language persistence (UI-only, no backend field in `Settings` struct)
- BYOK usage in chat (routing through BYOK providers is a separate feature)
- Shell/log file viewer (button opens folder, not a log viewer UI)
