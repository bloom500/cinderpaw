# Settings Page + BYOK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the React Settings page (General, Appearance, Hardware, API Server, Cloud Keys/BYOK, Privacy, About) with a Zustand store and Tauri IPC integration, replacing the current StubPage at `/settings`.

**Architecture:** Shell + per-tab components pattern (mirrors ModelsPage). A new `settings.ts` Zustand store owns all IPC — fetch, optimistic update, save, BYOK save/test. Each tab component is a focused file that reads/writes the store. ByokTab uses shadcn Collapsible with per-provider save/test.

**Tech Stack:** React 18, TypeScript, Zustand, Vitest + Testing Library, `@tauri-apps/plugin-dialog` (folder picker), `@tauri-apps/plugin-shell` (shell open), shadcn/ui Collapsible.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `frontend-react/src/lib/tauri/index.ts` | Add `ByokProvider` type, update `getByokSettings` return type |
| Create | `frontend-react/src/stores/settings.ts` | fetch/save settings + byok state |
| Create | `frontend-react/src/stores/__tests__/settings.test.ts` | store unit tests |
| Create | `frontend-react/src/pages/SettingsPage.tsx` | shell: sidebar nav + active tab mount |
| Create | `frontend-react/src/components/settings/AppearanceTab.tsx` | theme segmented control |
| Create | `frontend-react/src/components/settings/HardwareTab.tsx` | GPU toggle, slider, HW info card, save |
| Create | `frontend-react/src/components/settings/__tests__/HardwareTab.test.tsx` | toggle/slider/save tests |
| Create | `frontend-react/src/components/settings/GeneralTab.tsx` | version, language, data folder picker, logs open |
| Create | `frontend-react/src/components/settings/ApiServerTab.tsx` | enable toggle, port input, URL copy, save |
| Create | `frontend-react/src/components/settings/ByokTab.tsx` | accordion BYOK providers |
| Create | `frontend-react/src/components/settings/__tests__/ByokTab.test.tsx` | accordion, save, test result tests |
| Create | `frontend-react/src/components/settings/PrivacyTab.tsx` | static pledge card |
| Create | `frontend-react/src/components/settings/AboutTab.tsx` | static version + links |
| Modify | `frontend-react/src/router.tsx` | wire `/settings` → `<SettingsPage />` |
| Modify | `frontend-react/src/components/layout/Sidebar.tsx` | enable Settings menu item |

---

## Task 1: Add ByokProvider type to IPC façade

**Files:**
- Modify: `frontend-react/src/lib/tauri/index.ts`

- [ ] **Step 1: Add `ByokProvider` export and update `getByokSettings` return type**

Open `frontend-react/src/lib/tauri/index.ts`. After the `Settings` interface (around line 78), add:

```ts
export interface ByokProvider {
  id: string;
  name: string;
  enabled: boolean;
  api_key: string;
  base_url?: string | null;
  default_model?: string | null;
}
```

Then update the `raw.getByokSettings` line (around line 129) from:
```ts
getByokSettings:  ()    => invoke<object[]>('get_byok_settings'),
```
to:
```ts
getByokSettings:  ()    => invoke<ByokProvider[]>('get_byok_settings'),
```

- [ ] **Step 2: Verify TypeScript compiles**

```
cd frontend-react && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend-react/src/lib/tauri/index.ts
git commit -m "feat(settings): add ByokProvider type to IPC façade"
```

---

## Task 2: `stores/settings.ts` + tests

**Files:**
- Create: `frontend-react/src/stores/settings.ts`
- Create: `frontend-react/src/stores/__tests__/settings.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `frontend-react/src/stores/__tests__/settings.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/tauri', () => ({
  tauri: {
    settings: {
      get:  vi.fn(),
      save: vi.fn(),
    },
    raw: {
      getByokSettings:   vi.fn(),
      saveByokProvider:  vi.fn(),
      testByokProvider:  vi.fn(),
    },
  },
}));

import { useSettings } from '@/stores/settings';
import { tauri } from '@/lib/tauri';

const mockGet      = vi.mocked(tauri.settings.get);
const mockSave     = vi.mocked(tauri.settings.save);
const mockGetByok  = vi.mocked(tauri.raw.getByokSettings);
const mockSaveByok = vi.mocked(tauri.raw.saveByokProvider);
const mockTestByok = vi.mocked(tauri.raw.testByokProvider);

const sample = {
  models_dir: '/home/.feral/models',
  default_gpu_layers: 100,
  api_server_enabled: false,
  api_port: 11435,
  version: '0.1.0',
};

const reset = () =>
  useSettings.setState({ settings: null, byok: [], loading: false, saving: false, saved: false });

describe('useSettings', () => {
  beforeEach(() => { reset(); vi.clearAllMocks(); });

  it('updateSettings patches settings locally without IPC call', () => {
    useSettings.setState({ settings: { ...sample } });
    useSettings.getState().updateSettings({ models_dir: '/new/path' });
    expect(useSettings.getState().settings?.models_dir).toBe('/new/path');
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('fetchSettings populates settings from Tauri', async () => {
    mockGet.mockResolvedValue(sample);
    await useSettings.getState().fetchSettings();
    expect(useSettings.getState().settings).toEqual(sample);
    expect(useSettings.getState().loading).toBe(false);
  });

  it('save calls tauri.settings.save with current settings', async () => {
    useSettings.setState({ settings: sample });
    mockSave.mockResolvedValue(undefined);
    await useSettings.getState().save();
    expect(mockSave).toHaveBeenCalledWith(sample);
    expect(useSettings.getState().saved).toBe(true);
  });

  it('save resets saved flag after 2 s', async () => {
    vi.useFakeTimers();
    useSettings.setState({ settings: sample });
    mockSave.mockResolvedValue(undefined);
    await useSettings.getState().save();
    expect(useSettings.getState().saved).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(useSettings.getState().saved).toBe(false);
    vi.useRealTimers();
  });

  it('fetchByok populates byok array from Tauri', async () => {
    const data = [{ id: 'openai', name: 'OpenAI', enabled: true, api_key: 'sk-***' }];
    mockGetByok.mockResolvedValue(data as any);
    await useSettings.getState().fetchByok();
    expect(useSettings.getState().byok).toEqual(data);
  });

  it('testByokProvider returns ok:true on success', async () => {
    mockTestByok.mockResolvedValue({ ok: true } as any);
    const result = await useSettings.getState().testByokProvider({
      providerId: 'openai', apiKey: 'sk-test', baseUrl: null,
    });
    expect(result.ok).toBe(true);
  });

  it('testByokProvider returns ok:false when Tauri throws', async () => {
    mockTestByok.mockRejectedValue(new Error('Network error'));
    const result = await useSettings.getState().testByokProvider({
      providerId: 'openai', apiKey: 'sk-test', baseUrl: null,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Network error');
  });
});
```

- [ ] **Step 2: Run tests — expect failures (store doesn't exist yet)**

```
cd frontend-react && npx vitest run src/stores/__tests__/settings.test.ts
```

Expected: FAIL — "Cannot find module '@/stores/settings'"

- [ ] **Step 3: Create `stores/settings.ts`**

Create `frontend-react/src/stores/settings.ts`:

```ts
import { create } from 'zustand';
import { tauri, type Settings, type ByokProvider } from '@/lib/tauri';

export type { ByokProvider };

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

export const useSettings = create<SettingsStore>()((set, get) => ({
  settings: null,
  byok: [],
  loading: false,
  saving: false,
  saved: false,

  fetchSettings: async () => {
    set({ loading: true });
    try {
      const settings = await tauri.settings.get();
      set({ settings, loading: false });
    } catch (e) {
      console.error('fetchSettings failed', e);
      set({ loading: false });
    }
  },

  fetchByok: async () => {
    try {
      const byok = await tauri.raw.getByokSettings();
      set({ byok });
    } catch (e) {
      console.error('fetchByok failed', e);
    }
  },

  updateSettings: (patch) => {
    set((s) => s.settings ? { settings: { ...s.settings, ...patch } } : {});
  },

  save: async () => {
    const { settings } = get();
    if (!settings) return;
    set({ saving: true });
    try {
      await tauri.settings.save(settings);
      set({ saving: false, saved: true });
      setTimeout(() => useSettings.setState({ saved: false }), 2000);
    } catch (e) {
      console.error('save failed', e);
      set({ saving: false });
    }
  },

  saveByokProvider: async (p) => {
    await tauri.raw.saveByokProvider(p.providerId, p.enabled, p.apiKey, p.baseUrl, p.defaultModel);
    await get().fetchByok();
  },

  testByokProvider: async (p) => {
    try {
      const result = await tauri.raw.testByokProvider(p.providerId, p.apiKey, p.baseUrl) as ByokTestResult;
      return result;
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
}));
```

- [ ] **Step 4: Run tests — expect all pass**

```
cd frontend-react && npx vitest run src/stores/__tests__/settings.test.ts
```

Expected: 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend-react/src/stores/settings.ts frontend-react/src/stores/__tests__/settings.test.ts
git commit -m "feat(settings): add settings + byok Zustand store"
```

---

## Task 3: `SettingsPage.tsx` shell

**Files:**
- Create: `frontend-react/src/pages/SettingsPage.tsx`

- [ ] **Step 1: Create the shell**

Create `frontend-react/src/pages/SettingsPage.tsx`:

```tsx
import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useSettings } from '@/stores/settings';
import { GeneralTab }    from '@/components/settings/GeneralTab';
import { AppearanceTab } from '@/components/settings/AppearanceTab';
import { HardwareTab }   from '@/components/settings/HardwareTab';
import { ApiServerTab }  from '@/components/settings/ApiServerTab';
import { ByokTab }       from '@/components/settings/ByokTab';
import { PrivacyTab }    from '@/components/settings/PrivacyTab';
import { AboutTab }      from '@/components/settings/AboutTab';

type Category = 'general' | 'appearance' | 'hardware' | 'api' | 'byok' | 'privacy' | 'about';

const CATS: { id: Category; label: string; icon: string }[] = [
  { id: 'general',    label: 'General',     icon: '⚙' },
  { id: 'appearance', label: 'Appearance',  icon: '◐' },
  { id: 'hardware',   label: 'Hardware',    icon: '⌬' },
  { id: 'api',        label: 'API Server',  icon: '⇄' },
  { id: 'byok',       label: 'Cloud Keys',  icon: '⚷' },
  { id: 'privacy',    label: 'Privacy',     icon: '⚿' },
  { id: 'about',      label: 'About',       icon: 'ⓘ' },
];

export function SettingsPage() {
  const [cat, setCat] = useState<Category>('general');
  const fetchSettings = useSettings((s) => s.fetchSettings);
  const fetchByok     = useSettings((s) => s.fetchByok);

  useEffect(() => {
    void fetchSettings();
    void fetchByok();
  }, [fetchSettings, fetchByok]);

  return (
    <div className="flex h-full overflow-hidden">
      <aside className="w-44 shrink-0 border-r border-border-subtle flex flex-col py-2 overflow-y-auto">
        {CATS.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setCat(c.id)}
            className={cn(
              'flex items-center gap-2.5 px-4 py-2 text-sm text-left transition-colors',
              cat === c.id
                ? 'bg-bg-active text-text-primary font-medium'
                : 'text-text-secondary hover:bg-bg-hover',
            )}
          >
            <span className="shrink-0">{c.icon}</span>
            <span>{c.label}</span>
          </button>
        ))}
      </aside>
      <div className="flex-1 overflow-y-auto p-6 max-w-2xl">
        {cat === 'general'    && <GeneralTab />}
        {cat === 'appearance' && <AppearanceTab />}
        {cat === 'hardware'   && <HardwareTab />}
        {cat === 'api'        && <ApiServerTab />}
        {cat === 'byok'       && <ByokTab />}
        {cat === 'privacy'    && <PrivacyTab />}
        {cat === 'about'      && <AboutTab />}
      </div>
    </div>
  );
}
```

Note: tab component files don't exist yet — TypeScript will error until Tasks 4–9 complete. That's fine during development; compile check is in Task 10.

- [ ] **Step 2: Commit**

```bash
git add frontend-react/src/pages/SettingsPage.tsx
git commit -m "feat(settings): add SettingsPage shell"
```

---

## Task 4: `AppearanceTab.tsx`

**Files:**
- Create: `frontend-react/src/components/settings/AppearanceTab.tsx`

- [ ] **Step 1: Create AppearanceTab**

Create `frontend-react/src/components/settings/AppearanceTab.tsx`:

```tsx
import { cn } from '@/lib/utils';
import { useUI, type ThemePref } from '@/stores/ui';

const THEMES: { value: ThemePref; label: string }[] = [
  { value: 'dark',   label: 'Dark' },
  { value: 'light',  label: 'Light' },
  { value: 'system', label: 'System' },
];

export function AppearanceTab() {
  const theme    = useUI((s) => s.theme);
  const setTheme = useUI((s) => s.setTheme);

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-text-primary">Appearance</h2>

      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-text-primary">Theme</p>
          <p className="text-xs text-text-muted mt-0.5">Pick how Feral looks</p>
        </div>
        <div className="flex rounded-md border border-border-subtle overflow-hidden">
          {THEMES.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => setTheme(value)}
              className={cn(
                'px-3 py-1.5 text-sm transition-colors',
                theme === value
                  ? 'bg-bg-active text-text-primary font-medium'
                  : 'text-text-secondary hover:bg-bg-hover',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend-react/src/components/settings/AppearanceTab.tsx
git commit -m "feat(settings): add AppearanceTab"
```

---

## Task 5: `HardwareTab.tsx` + tests

**Files:**
- Create: `frontend-react/src/components/settings/HardwareTab.tsx`
- Create: `frontend-react/src/components/settings/__tests__/HardwareTab.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `frontend-react/src/components/settings/__tests__/HardwareTab.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HardwareTab } from '@/components/settings/HardwareTab';
import { useSettings } from '@/stores/settings';
import { useSystemInfo } from '@/stores/systemInfo';

vi.mock('@/stores/settings',  () => ({ useSettings:  vi.fn() }));
vi.mock('@/stores/systemInfo', () => ({ useSystemInfo: vi.fn() }));

const mockUseSettings  = vi.mocked(useSettings);
const mockUseSystemInfo = vi.mocked(useSystemInfo);

const mockSave   = vi.fn().mockResolvedValue(undefined);
const mockUpdate = vi.fn();

const baseSettings = {
  models_dir: '/m', default_gpu_layers: 100,
  api_server_enabled: false, api_port: 11435, version: '0.1.0',
};

function setupStore(overrides: Partial<typeof baseSettings> = {}, saved = false) {
  mockUseSettings.mockImplementation((sel: any) =>
    sel({ settings: { ...baseSettings, ...overrides }, updateSettings: mockUpdate, save: mockSave, saved, saving: false })
  );
  mockUseSystemInfo.mockImplementation((sel: any) =>
    sel({ info: null, loading: false, fetch: vi.fn() })
  );
}

describe('HardwareTab', () => {
  beforeEach(() => { vi.clearAllMocks(); setupStore(); });

  it('toggle OFF calls updateSettings with default_gpu_layers: 0', async () => {
    render(<HardwareTab />);
    await userEvent.click(screen.getByRole('switch'));
    expect(mockUpdate).toHaveBeenCalledWith({ default_gpu_layers: 0 });
  });

  it('toggle ON (when currently 0) calls updateSettings with 100', async () => {
    setupStore({ default_gpu_layers: 0 });
    render(<HardwareTab />);
    await userEvent.click(screen.getByRole('switch'));
    expect(mockUpdate).toHaveBeenCalledWith({ default_gpu_layers: 100 });
  });

  it('Save button calls store.save', async () => {
    render(<HardwareTab />);
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(mockSave).toHaveBeenCalled();
  });

  it('shows ✓ Saved text when saved=true', () => {
    setupStore({}, true);
    render(<HardwareTab />);
    expect(screen.getByText('✓ Saved')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

```
cd frontend-react && npx vitest run src/components/settings/__tests__/HardwareTab.test.tsx
```

Expected: FAIL — "Cannot find module '@/components/settings/HardwareTab'"

- [ ] **Step 3: Create HardwareTab**

Create `frontend-react/src/components/settings/HardwareTab.tsx`:

```tsx
import { useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useSettings } from '@/stores/settings';
import { useSystemInfo } from '@/stores/systemInfo';

export function HardwareTab() {
  const settings = useSettings((s) => s.settings);
  const update   = useSettings((s) => s.updateSettings);
  const save     = useSettings((s) => s.save);
  const saved    = useSettings((s) => s.saved);
  const saving   = useSettings((s) => s.saving);

  const info  = useSystemInfo((s) => s.info);
  const fetch = useSystemInfo((s) => s.fetch);
  useEffect(() => { void fetch(); }, [fetch]);

  const gpuOn = (settings?.default_gpu_layers ?? 100) !== 0;
  const gpuPct = Math.min(100, Math.max(0, settings?.default_gpu_layers ?? 100));

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-text-primary">Hardware</h2>

      {/* GPU toggle */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-text-primary">GPU acceleration</p>
          <p className="text-xs text-text-muted mt-0.5">
            {info
              ? `${info.gpu_name} · ${info.supports_vulkan ? 'Vulkan available' : 'Vulkan unavailable'}`
              : 'Detecting…'}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={gpuOn}
          onClick={() => update({ default_gpu_layers: gpuOn ? 0 : 100 })}
          className={cn(
            'w-10 h-6 rounded-full transition-colors relative shrink-0',
            gpuOn ? 'bg-blue-500' : 'bg-bg-hover',
          )}
        >
          <span
            className={cn(
              'absolute top-1 w-4 h-4 rounded-full bg-white transition-transform',
              gpuOn ? 'translate-x-5' : 'translate-x-1',
            )}
          />
        </button>
      </div>

      {/* GPU usage slider */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-text-primary">GPU usage</p>
            <p className="text-xs text-text-muted mt-0.5">0% = CPU only · 100% = Full GPU offload</p>
          </div>
          <span className="text-sm text-text-secondary tabular-nums">{gpuPct}%</span>
        </div>
        <input
          type="range" min={0} max={100} step={1}
          value={gpuPct}
          onChange={(e) => update({ default_gpu_layers: Number(e.target.value) })}
          className="w-full accent-blue-500"
        />
        <div className="flex justify-between text-xs text-text-muted">
          <span>CPU</span>
          <span>GPU</span>
        </div>
      </div>

      {/* HW info card */}
      {info && (
        <div className="rounded-lg border border-border-subtle p-4 space-y-2 bg-bg-surface">
          <div className="flex justify-between text-sm">
            <span className="text-text-muted">GPU</span>
            <span className="text-text-primary">
              {info.vram_total_mb > 0
                ? `${info.gpu_name} · ${Math.round(info.vram_total_mb / 1024)} GB VRAM`
                : info.gpu_name}
            </span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-text-muted">RAM</span>
            <span className="text-text-primary">{Math.round(info.ram_total_mb / 1024)} GB</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-text-muted">CPU</span>
            <span className="text-text-primary">{info.cpu}</span>
          </div>
        </div>
      )}

      {/* Save */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !settings}
          className="px-4 py-2 rounded-md bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium disabled:opacity-50 transition-colors"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="text-sm text-text-muted">✓ Saved</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests — expect all pass**

```
cd frontend-react && npx vitest run src/components/settings/__tests__/HardwareTab.test.tsx
```

Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend-react/src/components/settings/HardwareTab.tsx frontend-react/src/components/settings/__tests__/HardwareTab.test.tsx
git commit -m "feat(settings): add HardwareTab with GPU toggle/slider"
```

---

## Task 6: `GeneralTab.tsx`

**Files:**
- Create: `frontend-react/src/components/settings/GeneralTab.tsx`

- [ ] **Step 1: Create GeneralTab**

Create `frontend-react/src/components/settings/GeneralTab.tsx`:

```tsx
import { useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { useSettings } from '@/stores/settings';

export function GeneralTab() {
  const settings = useSettings((s) => s.settings);
  const update   = useSettings((s) => s.updateSettings);
  const save     = useSettings((s) => s.save);
  const saved    = useSettings((s) => s.saved);
  const [language, setLanguage] = useState('en');

  const handleChangeFolder = async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected === 'string' && selected) {
      update({ models_dir: selected });
      await save();
    }
  };

  const handleOpenFolder = async () => {
    if (settings?.models_dir) {
      await shellOpen(settings.models_dir);
    }
  };

  const handleOpenLogs = async () => {
    if (!settings?.models_dir) return;
    // Go one level up from models_dir (e.g. ~/.feral/models → ~/.feral)
    const parent = settings.models_dir.replace(/[/\\][^/\\]+[/\\]?$/, '');
    await shellOpen(parent || settings.models_dir);
  };

  const rowCls = 'flex items-center justify-between gap-4';
  const btnCls = 'px-3 py-1.5 rounded-md border border-border-subtle text-sm text-text-secondary hover:bg-bg-hover transition-colors shrink-0';

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-text-primary">General</h2>

      {/* App version */}
      <div className={rowCls}>
        <div>
          <p className="text-sm font-medium text-text-primary">App version</p>
          <p className="text-xs text-text-muted mt-0.5">{settings?.version ?? 'v0.1.0'}</p>
        </div>
        <button type="button" disabled className={`${btnCls} opacity-50 cursor-not-allowed`}>
          Check for updates
        </button>
      </div>

      {/* Language */}
      <div className={rowCls}>
        <div>
          <p className="text-sm font-medium text-text-primary">Language</p>
          <p className="text-xs text-text-muted mt-0.5">Interface language</p>
        </div>
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          className="px-2 py-1.5 rounded-md border border-border-subtle bg-bg-surface text-sm text-text-primary"
        >
          <option value="en">English</option>
          <option value="ro">Română</option>
        </select>
      </div>

      {/* Data folder */}
      <div className={rowCls}>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-text-primary">Data folder</p>
          <p className="text-xs text-text-muted mt-0.5 truncate">
            {settings?.models_dir ?? '~/.feral/models'}
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button type="button" onClick={() => void handleChangeFolder()} className={btnCls}>
            Change
          </button>
          <button type="button" onClick={() => void handleOpenFolder()} className={btnCls}>
            Open
          </button>
        </div>
      </div>

      {/* App logs */}
      <div className={rowCls}>
        <div>
          <p className="text-sm font-medium text-text-primary">Application logs</p>
          <p className="text-xs text-text-muted mt-0.5">Detailed runtime logs for troubleshooting</p>
        </div>
        <button type="button" onClick={() => void handleOpenLogs()} className={btnCls}>
          Open logs
        </button>
      </div>

      {saved && <span className="text-sm text-text-muted">✓ Saved</span>}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend-react/src/components/settings/GeneralTab.tsx
git commit -m "feat(settings): add GeneralTab with folder picker"
```

---

## Task 7: `ApiServerTab.tsx`

**Files:**
- Create: `frontend-react/src/components/settings/ApiServerTab.tsx`

- [ ] **Step 1: Create ApiServerTab**

Create `frontend-react/src/components/settings/ApiServerTab.tsx`:

```tsx
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { useSettings } from '@/stores/settings';

export function ApiServerTab() {
  const settings = useSettings((s) => s.settings);
  const update   = useSettings((s) => s.updateSettings);
  const save     = useSettings((s) => s.save);
  const saved    = useSettings((s) => s.saved);
  const saving   = useSettings((s) => s.saving);
  const [copied, setCopied] = useState(false);

  const enabled = settings?.api_server_enabled ?? false;
  const port    = settings?.api_port ?? 11435;
  const apiUrl  = `http://localhost:${port}`;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(apiUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const btnCls = 'px-3 py-1.5 rounded-md border border-border-subtle text-sm text-text-secondary hover:bg-bg-hover transition-colors';
  const rowCls = 'flex items-center justify-between gap-4';

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-text-primary">API Server</h2>

      {/* Enable toggle */}
      <div className={rowCls}>
        <div>
          <p className="text-sm font-medium text-text-primary">Enable API server</p>
          <p className="text-xs text-text-muted mt-0.5">Expose models over a local HTTP API</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => update({ api_server_enabled: !enabled })}
          className={cn(
            'w-10 h-6 rounded-full transition-colors relative shrink-0',
            enabled ? 'bg-blue-500' : 'bg-bg-hover',
          )}
        >
          <span
            className={cn(
              'absolute top-1 w-4 h-4 rounded-full bg-white transition-transform',
              enabled ? 'translate-x-5' : 'translate-x-1',
            )}
          />
        </button>
      </div>

      {/* Port */}
      <div className={rowCls}>
        <div>
          <p className="text-sm font-medium text-text-primary">Port</p>
          <p className="text-xs text-text-muted mt-0.5">Local port the API server listens on</p>
        </div>
        <input
          type="number"
          min={1024}
          max={65535}
          value={port}
          onChange={(e) => {
            const val = Number(e.target.value);
            if (val >= 1024 && val <= 65535) update({ api_port: val });
          }}
          className="w-24 px-2 py-1.5 rounded-md border border-border-subtle bg-bg-surface text-sm text-text-primary text-right"
        />
      </div>

      {/* Format */}
      <div className={rowCls}>
        <div>
          <p className="text-sm font-medium text-text-primary">Format</p>
          <p className="text-xs text-text-muted mt-0.5">Ollama-compatible + OpenAI-compatible</p>
        </div>
      </div>

      {/* API URL */}
      <div className="space-y-1.5">
        <p className="text-sm font-medium text-text-primary">API URL</p>
        <div className="flex gap-2">
          <input
            readOnly
            value={apiUrl}
            className="flex-1 px-2 py-1.5 rounded-md border border-border-subtle bg-bg-surface text-sm text-text-muted font-mono"
          />
          <button type="button" onClick={() => void handleCopy()} className={btnCls}>
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
        </div>
      </div>

      {/* Save */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !settings}
          className="px-4 py-2 rounded-md bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium disabled:opacity-50 transition-colors"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="text-sm text-text-muted">✓ Saved</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend-react/src/components/settings/ApiServerTab.tsx
git commit -m "feat(settings): add ApiServerTab"
```

---

## Task 8: `ByokTab.tsx` + tests

**Files:**
- Create: `frontend-react/src/components/settings/ByokTab.tsx`
- Create: `frontend-react/src/components/settings/__tests__/ByokTab.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `frontend-react/src/components/settings/__tests__/ByokTab.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ByokTab } from '@/components/settings/ByokTab';
import { useSettings } from '@/stores/settings';

vi.mock('@/stores/settings', () => ({ useSettings: vi.fn() }));
const mockUseSettings = vi.mocked(useSettings);

const mockSaveByok = vi.fn();
const mockTestByok = vi.fn();

function setupStore(byok: object[] = []) {
  mockUseSettings.mockImplementation((sel: any) =>
    sel({ byok, saveByokProvider: mockSaveByok, testByokProvider: mockTestByok })
  );
}

describe('ByokTab', () => {
  beforeEach(() => { vi.clearAllMocks(); setupStore(); });

  it('renders all 6 provider rows', () => {
    render(<ByokTab />);
    expect(screen.getByText('OpenAI')).toBeInTheDocument();
    expect(screen.getByText('Anthropic')).toBeInTheDocument();
    expect(screen.getByText('Google Gemini')).toBeInTheDocument();
    expect(screen.getByText('Groq')).toBeInTheDocument();
    expect(screen.getByText('Mistral')).toBeInTheDocument();
    expect(screen.getByText('Custom Endpoint')).toBeInTheDocument();
  });

  it('unconfigured providers show "Not configured" badge', () => {
    render(<ByokTab />);
    expect(screen.getAllByText('Not configured')).toHaveLength(6);
  });

  it('enabled provider with api_key shows "Active" badge', () => {
    setupStore([{ id: 'openai', name: 'OpenAI', enabled: true, api_key: 'sk-test' }]);
    render(<ByokTab />);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('expanding a row and clicking Save calls saveByokProvider with correct providerId', async () => {
    mockSaveByok.mockResolvedValue(undefined);
    render(<ByokTab />);
    await userEvent.click(screen.getByText('Anthropic'));
    const saveBtn = await screen.findByRole('button', { name: /^save$/i });
    await userEvent.click(saveBtn);
    expect(mockSaveByok).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'anthropic' }));
  });

  it('Test button calls testByokProvider and shows ✓ Connected on success', async () => {
    mockTestByok.mockResolvedValue({ ok: true });
    render(<ByokTab />);
    await userEvent.click(screen.getByText('OpenAI'));
    const keyInput = await screen.findByPlaceholderText('sk-...');
    await userEvent.type(keyInput, 'sk-validkey');
    await userEvent.click(screen.getByRole('button', { name: /^test$/i }));
    await waitFor(() => expect(screen.getByText('✓ Connected')).toBeInTheDocument());
  });

  it('Test button shows error message on failure', async () => {
    mockTestByok.mockResolvedValue({ ok: false, error: 'Invalid API key' });
    render(<ByokTab />);
    await userEvent.click(screen.getByText('OpenAI'));
    const keyInput = await screen.findByPlaceholderText('sk-...');
    await userEvent.type(keyInput, 'sk-bad');
    await userEvent.click(screen.getByRole('button', { name: /^test$/i }));
    await waitFor(() => expect(screen.getByText(/Invalid API key/)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

```
cd frontend-react && npx vitest run src/components/settings/__tests__/ByokTab.test.tsx
```

Expected: FAIL — "Cannot find module '@/components/settings/ByokTab'"

- [ ] **Step 3: Create ByokTab**

Create `frontend-react/src/components/settings/ByokTab.tsx`:

```tsx
import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useSettings, type ByokProviderUpdate } from '@/stores/settings';
import type { ByokProvider } from '@/lib/tauri';

const PROVIDER_DEFS = [
  { id: 'openai',    name: 'OpenAI',          hasBaseUrl: true  },
  { id: 'anthropic', name: 'Anthropic',       hasBaseUrl: false },
  { id: 'gemini',    name: 'Google Gemini',   hasBaseUrl: false },
  { id: 'groq',      name: 'Groq',            hasBaseUrl: false },
  { id: 'mistral',   name: 'Mistral',         hasBaseUrl: false },
  { id: 'custom',    name: 'Custom Endpoint', hasBaseUrl: true  },
] as const;

type ProviderDef = typeof PROVIDER_DEFS[number];

function ProviderRow({ def, state }: { def: ProviderDef; state?: ByokProvider }) {
  const saveByokProvider = useSettings((s) => s.saveByokProvider);
  const testByokProvider = useSettings((s) => s.testByokProvider);

  const [open, setOpen]               = useState(false);
  const [enabled, setEnabled]         = useState(state?.enabled ?? false);
  const [apiKey, setApiKey]           = useState(state?.api_key ?? '');
  const [baseUrl, setBaseUrl]         = useState(state?.base_url ?? '');
  const [defaultModel, setDefModel]   = useState(state?.default_model ?? '');
  const [showKey, setShowKey]         = useState(false);
  const [saving, setSaving]           = useState(false);
  const [saveMsg, setSaveMsg]         = useState<string | null>(null);
  const [testing, setTesting]         = useState(false);
  const [testMsg, setTestMsg]         = useState<string | null>(null);

  const isActive = !!(state?.enabled && state?.api_key);

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const p: ByokProviderUpdate = {
        providerId: def.id,
        enabled,
        apiKey,
        baseUrl: def.hasBaseUrl ? (baseUrl || null) : null,
        defaultModel: defaultModel || null,
      };
      await saveByokProvider(p);
      setSaveMsg('✓ Saved');
      setTimeout(() => setSaveMsg(null), 2000);
    } catch {
      setSaveMsg('Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      const result = await testByokProvider({
        providerId: def.id,
        apiKey,
        baseUrl: def.hasBaseUrl ? (baseUrl || null) : null,
      });
      setTestMsg(result.ok ? '✓ Connected' : `Error: ${result.error ?? 'Unknown error'}`);
    } catch (e) {
      setTestMsg(`Error: ${String(e)}`);
    } finally {
      setTesting(false);
    }
  };

  const inputCls = 'w-full px-2 py-1.5 rounded-md border border-border-subtle bg-bg-surface text-sm text-text-primary';
  const btnSecCls = 'px-3 py-1.5 rounded-md border border-border-subtle text-sm text-text-secondary hover:bg-bg-hover transition-colors disabled:opacity-50';

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="w-full flex items-center justify-between px-4 py-3 rounded-lg border border-border-subtle hover:bg-bg-hover transition-colors text-left">
        <span className="text-sm font-medium text-text-primary">{def.name}</span>
        <span className={cn(
          'text-xs px-2 py-0.5 rounded-full shrink-0',
          isActive ? 'bg-green-500/20 text-green-400' : 'bg-bg-hover text-text-muted',
        )}>
          {isActive ? 'Active' : 'Not configured'}
        </span>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="px-4 pt-3 pb-4 border border-t-0 border-border-subtle rounded-b-lg space-y-4">
          {/* Enabled */}
          <div className="flex items-center justify-between">
            <span className="text-sm text-text-secondary">Enabled</span>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              onClick={() => setEnabled(!enabled)}
              className={cn('w-10 h-6 rounded-full transition-colors relative shrink-0', enabled ? 'bg-blue-500' : 'bg-bg-hover')}
            >
              <span className={cn('absolute top-1 w-4 h-4 rounded-full bg-white transition-transform', enabled ? 'translate-x-5' : 'translate-x-1')} />
            </button>
          </div>

          {/* API Key */}
          <div className="space-y-1">
            <label className="text-xs text-text-muted">API Key</label>
            <div className="flex gap-2">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                className={cn(inputCls, 'flex-1 font-mono')}
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="px-2 py-1.5 rounded-md border border-border-subtle text-text-muted hover:bg-bg-hover"
                aria-label={showKey ? 'Hide key' : 'Show key'}
              >
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          {/* Base URL (only for providers that support it) */}
          {def.hasBaseUrl && (
            <div className="space-y-1">
              <label className="text-xs text-text-muted">Base URL</label>
              <input
                type="url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
                className={inputCls}
              />
            </div>
          )}

          {/* Default model */}
          <div className="space-y-1">
            <label className="text-xs text-text-muted">Default model (optional)</label>
            <input
              type="text"
              value={defaultModel}
              onChange={(e) => setDefModel(e.target.value)}
              placeholder="gpt-4o"
              className={inputCls}
            />
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3 flex-wrap">
            <button type="button" onClick={() => void handleTest()} disabled={testing || !apiKey} className={btnSecCls}>
              {testing ? 'Testing…' : 'Test'}
            </button>
            <button type="button" onClick={() => void handleSave()} disabled={saving} className="px-3 py-1.5 rounded-md bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium disabled:opacity-50 transition-colors">
              {saving ? 'Saving…' : 'Save'}
            </button>
            {testMsg && (
              <span className={cn('text-xs', testMsg.startsWith('✓') ? 'text-green-400' : 'text-red-400')}>
                {testMsg}
              </span>
            )}
            {saveMsg && (
              <span className={cn('text-xs', saveMsg.startsWith('✓') ? 'text-text-muted' : 'text-red-400')}>
                {saveMsg}
              </span>
            )}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ByokTab() {
  const byok = useSettings((s) => s.byok);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">Cloud Keys</h2>
        <p className="text-xs text-text-muted mt-1">Add API keys to use cloud AI providers alongside local models.</p>
      </div>
      <div className="space-y-2">
        {PROVIDER_DEFS.map((def) => (
          <ProviderRow
            key={def.id}
            def={def}
            state={byok.find((b) => b.id === def.id)}
          />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests — expect all pass**

```
cd frontend-react && npx vitest run src/components/settings/__tests__/ByokTab.test.tsx
```

Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend-react/src/components/settings/ByokTab.tsx frontend-react/src/components/settings/__tests__/ByokTab.test.tsx
git commit -m "feat(settings): add ByokTab with accordion providers + tests"
```

---

## Task 9: `PrivacyTab.tsx` + `AboutTab.tsx`

**Files:**
- Create: `frontend-react/src/components/settings/PrivacyTab.tsx`
- Create: `frontend-react/src/components/settings/AboutTab.tsx`

- [ ] **Step 1: Create PrivacyTab**

Create `frontend-react/src/components/settings/PrivacyTab.tsx`:

```tsx
export function PrivacyTab() {
  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-text-primary">Privacy</h2>

      <div className="flex gap-4 p-4 rounded-lg border border-border-subtle bg-bg-surface">
        <span className="text-2xl shrink-0">⚿</span>
        <div>
          <p className="text-sm font-medium text-text-primary">Your data never leaves this machine</p>
          <p className="text-xs text-text-muted mt-1">
            Feral runs entirely on your hardware. No telemetry, no analytics, no cloud sync — by design.
          </p>
        </div>
      </div>

      <div>
        <p className="text-sm font-medium text-text-primary">Data collection</p>
        <p className="text-xs text-text-muted mt-0.5">Disabled — Feral never collects or transmits your data</p>
      </div>

      <ul className="space-y-1.5 text-sm text-text-secondary">
        {[
          'All conversations stored locally only',
          'Models stored locally only',
          'No background network requests',
          'Cloud providers (BYOK) only contacted when you explicitly send a message',
        ].map((item) => (
          <li key={item} className="flex items-start gap-2">
            <span className="text-text-muted mt-0.5">·</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Create AboutTab**

Create `frontend-react/src/components/settings/AboutTab.tsx`:

```tsx
import { useSettings } from '@/stores/settings';

export function AboutTab() {
  const version = useSettings((s) => s.settings?.version ?? 'v0.1.0');

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-text-primary">About</h2>

      <div className="space-y-1">
        <p className="text-sm font-semibold text-text-primary">Feral {version}</p>
        <p className="text-xs text-text-muted">Local-first AI desktop, built with Tauri + React</p>
        <p className="text-xs text-text-muted">
          Built by <span className="font-medium text-text-secondary">Bloom Lab</span> · License: MIT + Apache 2.0
        </p>
      </div>

      <div className="space-y-2">
        <a
          href="https://github.com/bloommediacorporation-lab/feral"
          target="_blank"
          rel="noreferrer"
          className="block text-sm text-blue-400 hover:underline"
        >
          View on GitHub →
        </a>
        <a
          href="https://github.com/bloommediacorporation-lab/feral/issues"
          target="_blank"
          rel="noreferrer"
          className="block text-sm text-blue-400 hover:underline"
        >
          Report an issue →
        </a>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend-react/src/components/settings/PrivacyTab.tsx frontend-react/src/components/settings/AboutTab.tsx
git commit -m "feat(settings): add PrivacyTab and AboutTab (static)"
```

---

## Task 10: Router + Sidebar wiring + full test run

**Files:**
- Modify: `frontend-react/src/router.tsx`
- Modify: `frontend-react/src/components/layout/Sidebar.tsx`

- [ ] **Step 1: Wire `/settings` route in `router.tsx`**

In `frontend-react/src/router.tsx`, add the import and replace the StubPage entry:

```ts
// Add import at top:
import { SettingsPage } from '@/pages/SettingsPage';

// Replace:
{ path: 'settings', element: <StubPage title="Settings" message="Coming in spec 4" /> },
// With:
{ path: 'settings', element: <SettingsPage /> },
```

- [ ] **Step 2: Enable Settings in Sidebar**

In `frontend-react/src/components/layout/Sidebar.tsx`, find the Settings menu item (around line 31) and change `disabled: true` to `disabled: false`:

```ts
// Before:
{ icon: Settings, label: 'Settings', shortcut: null, action: 'settings', disabled: true,  route: '/settings' },
// After:
{ icon: Settings, label: 'Settings', shortcut: null, action: 'settings', disabled: false, route: '/settings' },
```

- [ ] **Step 3: TypeScript check**

```
cd frontend-react && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Run full test suite**

```
cd frontend-react && npx vitest run
```

Expected: all existing tests + new tests PASS. Verify the count includes:
- `stores/__tests__/settings.test.ts` (7 tests)
- `components/settings/__tests__/HardwareTab.test.tsx` (4 tests)
- `components/settings/__tests__/ByokTab.test.tsx` (5 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend-react/src/router.tsx frontend-react/src/components/layout/Sidebar.tsx
git commit -m "feat(settings): wire Settings route + enable Sidebar link"
```

---

## Self-Review Notes

- **Spec § 4.3 AppearanceTab** — reads `useUI(s => s.theme)`, writes `useUI.getState().setTheme()`. Theme is persisted in `ui.ts` — no `settings.ts` involvement. ✓
- **Spec § 4.4 HardwareTab** — `useSystemInfo` fetch triggered via `useEffect`. ✓
- **Spec § 4.5 GeneralTab** — `@tauri-apps/plugin-dialog` `open({ directory: true })`, `@tauri-apps/plugin-shell` `open()`. Both plugins confirmed installed. ✓
- **Spec § 4.6 ByokTab** — BYOK_PROVIDERS matches spec's 6 providers exactly. `hasBaseUrl: true` for OpenAI and Custom. ✓
- **Type consistency** — `ByokProvider` defined in `lib/tauri/index.ts` (Task 1), imported by `stores/settings.ts` (Task 2) and `ByokTab.tsx` (Task 8). `ByokProviderUpdate` defined in `stores/settings.ts` and imported by `ByokTab.tsx`. ✓
- **Port validation** — ApiServerTab validates 1024–65535 before calling `updateSettings`. ✓
- **Error handling** — fetchSettings/fetchByok log to console on failure; save shows no success toast on error; testByokProvider returns `{ ok: false }` on throw. ✓
