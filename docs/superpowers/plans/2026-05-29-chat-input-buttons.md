# Chat Input Toolbar Buttons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the three ChatInput toolbar buttons functional — Paperclip (file attach with chips), Wrench (per-tool toggles dropdown), Brain (reasoning mode Auto/On/Off with color badges).

**Architecture:** Store additions in `useUI` for reasoning mode and enabled tools (persisted); file attach state is local to `ChatInput`; a new Rust command `read_file_as_text` reads selected files; `currentInferParams` gains reasoning awareness; `MessageItem` reads reasoning mode directly from store to suppress thinking blocks.

**Tech Stack:** React + Zustand + Vitest + Tauri 2 (`tauri-plugin-dialog`) + `@tauri-apps/plugin-dialog` + existing `@radix-ui/react-dropdown-menu`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `stores/ui.ts` | Modify | Add `reasoningMode`, `enabledTools`, actions |
| `lib/modelUtils.ts` | Modify | Add `modelSupportsThinking()` |
| `lib/__tests__/modelUtils.test.ts` | Modify | Tests for `modelSupportsThinking` |
| `lib/inferParams.ts` | Modify | Accept reasoning opts, compute `enableThinking` |
| `lib/__tests__/inferParams.test.ts` | Create | Tests for updated `currentInferParams` |
| `src-tauri/Cargo.toml` | Modify | Add `tauri-plugin-dialog` |
| `src-tauri/src/lib.rs` | Modify | Register plugin + add `read_file_as_text` command |
| `src-tauri/capabilities/default.json` | Modify | Add `dialog:default` permission |
| `frontend-react/package.json` | Modify | Add `@tauri-apps/plugin-dialog` |
| `lib/tauri/index.ts` | Modify | Add `tauri.raw.readFileAsText` + `tauri.files.readAsText` |
| `components/chat/AttachedFileChip.tsx` | Create | Single chip UI (name + remove + error state) |
| `components/chat/FileAttachButton.tsx` | Create | Dialog open + file reading logic |
| `components/chat/ToolsPopover.tsx` | Create | Dropdown with per-tool checkbox toggles |
| `components/chat/ChatInput.tsx` | Modify | Wire all 3 buttons, chips row above textarea |
| `hooks/useSendMessage.ts` | Modify | Prepend file content, pass reasoning to inferParams |
| `components/chat/MessageItem.tsx` | Modify | Hide ThinkingBlock when reasoningMode = 'off' |

---

## Task 1: Add `reasoningMode` and `enabledTools` to `useUI` store

**Files:**
- Modify: `frontend-react/src/stores/ui.ts`
- Create: `frontend-react/src/stores/__tests__/ui.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend-react/src/stores/__tests__/ui.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useUI } from '@/stores/ui';

const reset = () =>
  useUI.setState({
    sidebarCollapsed: false,
    theme: 'system',
    resolvedTheme: 'dark',
    reasoningMode: 'auto',
    enabledTools: [],
  });

describe('useUI reasoning', () => {
  beforeEach(reset);

  it('default reasoningMode is auto', () => {
    expect(useUI.getState().reasoningMode).toBe('auto');
  });

  it('cycleReasoningMode: auto → on → off → auto', () => {
    const s = useUI.getState();
    s.cycleReasoningMode();
    expect(useUI.getState().reasoningMode).toBe('on');
    s.cycleReasoningMode();
    expect(useUI.getState().reasoningMode).toBe('off');
    s.cycleReasoningMode();
    expect(useUI.getState().reasoningMode).toBe('auto');
  });
});

describe('useUI tools', () => {
  beforeEach(reset);

  it('default enabledTools is empty', () => {
    expect(useUI.getState().enabledTools).toEqual([]);
  });

  it('toggleTool adds a tool', () => {
    useUI.getState().toggleTool('web_search');
    expect(useUI.getState().enabledTools).toContain('web_search');
  });

  it('toggleTool removes an already-active tool', () => {
    useUI.getState().toggleTool('web_search');
    useUI.getState().toggleTool('web_search');
    expect(useUI.getState().enabledTools).not.toContain('web_search');
  });

  it('toggleTool keeps other tools intact', () => {
    useUI.getState().toggleTool('web_search');
    useUI.getState().toggleTool('file_read');
    useUI.getState().toggleTool('web_search');
    expect(useUI.getState().enabledTools).toEqual(['file_read']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd frontend-react
npx vitest run src/stores/__tests__/ui.test.ts
```

Expected: FAIL — `cycleReasoningMode is not a function`

- [ ] **Step 3: Update `stores/ui.ts`**

Replace the entire file with:

```ts
import { useEffect } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ThemePref = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';
export type ReasoningMode = 'auto' | 'on' | 'off';
export type ToolId = 'web_search' | 'http_request' | 'file_read' | 'file_write' | 'code_execute';

const REASONING_CYCLE: ReasoningMode[] = ['auto', 'on', 'off'];

interface UIStore {
  sidebarCollapsed: boolean;
  theme: ThemePref;
  resolvedTheme: ResolvedTheme;
  reasoningMode: ReasoningMode;
  enabledTools: ToolId[];
  toggleSidebar: () => void;
  setTheme: (t: ThemePref) => void;
  cycleReasoningMode: () => void;
  setReasoningMode: (m: ReasoningMode) => void;
  toggleTool: (id: ToolId) => void;
}

const getSystemTheme = (): ResolvedTheme =>
  window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

const resolveTheme = (t: ThemePref): ResolvedTheme =>
  t === 'system' ? getSystemTheme() : t;

const applyTheme = (resolved: ResolvedTheme) =>
  document.documentElement.setAttribute('data-theme', resolved);

export const useUI = create<UIStore>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      theme: 'system',
      resolvedTheme: 'dark',
      reasoningMode: 'auto',
      enabledTools: [],
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setTheme: (theme) => {
        const resolved = resolveTheme(theme);
        applyTheme(resolved);
        set({ theme, resolvedTheme: resolved });
      },
      cycleReasoningMode: () =>
        set((s) => {
          const idx = REASONING_CYCLE.indexOf(s.reasoningMode);
          return { reasoningMode: REASONING_CYCLE[(idx + 1) % REASONING_CYCLE.length] };
        }),
      setReasoningMode: (reasoningMode) => set({ reasoningMode }),
      toggleTool: (id) =>
        set((s) => ({
          enabledTools: s.enabledTools.includes(id)
            ? s.enabledTools.filter((t) => t !== id)
            : [...s.enabledTools, id],
        })),
    }),
    {
      name: 'feral-ui',
      partialize: (s) => ({
        sidebarCollapsed: s.sidebarCollapsed,
        theme: s.theme,
        reasoningMode: s.reasoningMode,
        enabledTools: s.enabledTools,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const resolved = resolveTheme(state.theme);
        applyTheme(resolved);
        state.resolvedTheme = resolved;
      },
    },
  ),
);

export function useSystemThemeSync() {
  const theme = useUI((s) => s.theme);
  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      const resolved = getSystemTheme();
      applyTheme(resolved);
      useUI.setState({ resolvedTheme: resolved });
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);
}
```

- [ ] **Step 4: Run test to verify it passes**

```
cd frontend-react
npx vitest run src/stores/__tests__/ui.test.ts
```

Expected: PASS — all 5 tests green

- [ ] **Step 5: Commit**

```bash
git add frontend-react/src/stores/ui.ts frontend-react/src/stores/__tests__/ui.test.ts
git commit -m "feat(store): add reasoningMode cycle and enabledTools toggle to useUI"
```

---

## Task 2: Add `modelSupportsThinking` to `lib/modelUtils.ts`

**Files:**
- Modify: `frontend-react/src/lib/modelUtils.ts`
- Modify: `frontend-react/src/lib/__tests__/modelUtils.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to the end of `frontend-react/src/lib/__tests__/modelUtils.test.ts`:

```ts
import { modelSupportsThinking } from '@/lib/modelUtils';

describe('modelSupportsThinking', () => {
  it('matches "think" in name', () => {
    expect(modelSupportsThinking('Qwen3-think-Q4.gguf')).toBe(true);
  });
  it('matches "qwq" in name', () => {
    expect(modelSupportsThinking('QwQ-32B-Q4_K_M.gguf')).toBe(true);
  });
  it('matches "deepseek-r" in name', () => {
    expect(modelSupportsThinking('DeepSeek-R1-Distill-Q4.gguf')).toBe(true);
  });
  it('is case-insensitive', () => {
    expect(modelSupportsThinking('MISTRAL-THINK-7B.gguf')).toBe(true);
  });
  it('returns false for non-reasoning models', () => {
    expect(modelSupportsThinking('llama-3.2-3b-instruct-q4_k_m.gguf')).toBe(false);
    expect(modelSupportsThinking('mistral-7b-instruct.gguf')).toBe(false);
  });
  it('returns false for empty string', () => {
    expect(modelSupportsThinking('')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd frontend-react
npx vitest run src/lib/__tests__/modelUtils.test.ts
```

Expected: FAIL — `modelSupportsThinking is not a function`

- [ ] **Step 3: Add `modelSupportsThinking` to `lib/modelUtils.ts`**

Append to the end of `frontend-react/src/lib/modelUtils.ts`:

```ts
const THINKING_PATTERNS = /think|qwq|deepseek-r/i;

export function modelSupportsThinking(name: string): boolean {
  return THINKING_PATTERNS.test(name);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
cd frontend-react
npx vitest run src/lib/__tests__/modelUtils.test.ts
```

Expected: PASS — all modelUtils tests green (existing + new)

- [ ] **Step 5: Commit**

```bash
git add frontend-react/src/lib/modelUtils.ts frontend-react/src/lib/__tests__/modelUtils.test.ts
git commit -m "feat(utils): add modelSupportsThinking() for reasoning auto-detect"
```

---

## Task 3: Update `currentInferParams` to support reasoning mode

**Files:**
- Modify: `frontend-react/src/lib/inferParams.ts`
- Create: `frontend-react/src/lib/__tests__/inferParams.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `frontend-react/src/lib/__tests__/inferParams.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/tauri', () => ({
  tauri: {
    settings: {
      get: vi.fn().mockResolvedValue({
        models_dir: '',
        default_gpu_layers: 0,
        api_server_enabled: false,
        api_port: 8080,
        version: '0.1.0',
      }),
    },
  },
}));

import { currentInferParams } from '@/lib/inferParams';

beforeEach(() => {
  // reset module cache so settings re-fetch
  vi.resetModules();
});

describe('currentInferParams reasoning', () => {
  it('mode=on always returns enableThinking true', async () => {
    const params = await currentInferParams({ reasoningMode: 'on', modelName: 'llama.gguf' });
    expect(params.system_prompt).toContain('<think>');
  });

  it('mode=off always returns no thinking prompt', async () => {
    const params = await currentInferParams({ reasoningMode: 'off', modelName: 'qwq.gguf' });
    expect(params.system_prompt ?? '').not.toContain('<think>');
  });

  it('mode=auto with thinking model returns thinking prompt', async () => {
    const params = await currentInferParams({ reasoningMode: 'auto', modelName: 'QwQ-32B.gguf' });
    expect(params.system_prompt).toContain('<think>');
  });

  it('mode=auto with non-thinking model returns no thinking prompt', async () => {
    const params = await currentInferParams({ reasoningMode: 'auto', modelName: 'llama-3b.gguf' });
    expect(params.system_prompt ?? '').not.toContain('<think>');
  });

  it('no opts returns params without thinking prompt', async () => {
    const params = await currentInferParams();
    expect(params.system_prompt).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd frontend-react
npx vitest run src/lib/__tests__/inferParams.test.ts
```

Expected: FAIL — function signature mismatch

- [ ] **Step 3: Rewrite `lib/inferParams.ts`**

```ts
import { tauri, type InferParams, type Settings } from '@/lib/tauri';
import { modelSupportsThinking } from '@/lib/modelUtils';
import type { ReasoningMode } from '@/stores/ui';

let cachedSettings: Settings | null = null;

export async function ensureSettingsLoaded(): Promise<Settings> {
  if (cachedSettings) return cachedSettings;
  cachedSettings = await tauri.settings.get();
  return cachedSettings;
}

const THINKING_SYSTEM_PROMPT =
  'Think step by step inside <think>...</think> before answering.';

export async function currentInferParams(opts?: {
  reasoningMode?: ReasoningMode;
  modelName?: string;
}): Promise<InferParams> {
  await ensureSettingsLoaded();

  const mode = opts?.reasoningMode ?? 'auto';
  const name = opts?.modelName ?? '';

  const enableThinking =
    mode === 'on' ||
    (mode === 'auto' && modelSupportsThinking(name));

  return {
    temperature: 0.8,
    top_p: 0.95,
    repeat_penalty: 1.1,
    max_tokens: 2048,
    system_prompt: enableThinking ? THINKING_SYSTEM_PROMPT : null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```
cd frontend-react
npx vitest run src/lib/__tests__/inferParams.test.ts
```

Expected: PASS — all 5 tests green

- [ ] **Step 5: Commit**

```bash
git add frontend-react/src/lib/inferParams.ts frontend-react/src/lib/__tests__/inferParams.test.ts
git commit -m "feat(inferParams): wire reasoning mode into system prompt"
```

---

## Task 4: Add Tauri dialog plugin (Rust + config side)

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/capabilities/default.json`

- [ ] **Step 1: Add plugin to `Cargo.toml`**

In `src-tauri/Cargo.toml`, find the `[dependencies]` section and add:

```toml
tauri-plugin-dialog = "2"
```

- [ ] **Step 2: Register plugin in `lib.rs`**

In `src-tauri/src/lib.rs`, find `tauri::Builder::default()` (line ~917) and add `.plugin(tauri_plugin_dialog::init())` before `.manage(state)`:

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .manage(state)
    // ... rest unchanged
```

- [ ] **Step 3: Add `read_file_as_text` command**

Find the block of `#[tauri::command]` functions in `lib.rs`. Add this new command near the other file-related commands:

```rust
#[tauri::command]
async fn read_file_as_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}
```

- [ ] **Step 4: Register command in specta builder**

In the `tauri_specta::collect_commands!` macro (line ~862), add `read_file_as_text` to the list:

```rust
tauri_specta::collect_commands![
    // ... existing commands ...
    read_file_as_text,
]
```

- [ ] **Step 5: Add permission to capabilities**

In `src-tauri/capabilities/default.json`, add `"dialog:default"` to the permissions array:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Feral default permissions",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:event:allow-emit",
    "core:event:allow-listen",
    "core:event:allow-unlisten",
    "dialog:default"
  ]
}
```

- [ ] **Step 6: Verify Rust compiles**

```
cd src-tauri
cargo check
```

Expected: no errors (warnings about unused imports are OK)

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/lib.rs src-tauri/capabilities/default.json src-tauri/Cargo.lock
git commit -m "feat(rust): add tauri-plugin-dialog + read_file_as_text command"
```

---

## Task 5: Add dialog plugin and `readFileAsText` to frontend façade

**Files:**
- Modify: `frontend-react/package.json`
- Modify: `frontend-react/src/lib/tauri/index.ts`

- [ ] **Step 1: Install npm package**

```
cd frontend-react
npm install @tauri-apps/plugin-dialog
```

- [ ] **Step 2: Add `readFileAsText` to tauri façade**

In `frontend-react/src/lib/tauri/index.ts`, add to the `raw` object (after the existing entries before the closing `}`):

```ts
readFileAsText: (path: string) => invoke<string>('read_file_as_text', { path }),
```

Then add a new `files` namespace to the public `tauri` object (after `system`):

```ts
files: {
  readAsText: async (path: string) => raw.readFileAsText(path),
},
```

- [ ] **Step 3: Verify TypeScript compiles**

```
cd frontend-react
npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add frontend-react/package.json frontend-react/package-lock.json frontend-react/src/lib/tauri/index.ts
git commit -m "feat(frontend): add @tauri-apps/plugin-dialog + files.readAsText facade"
```

---

## Task 6: Create `AttachedFileChip` component

**Files:**
- Create: `frontend-react/src/components/chat/AttachedFileChip.tsx`

- [ ] **Step 1: Create the component**

Create `frontend-react/src/components/chat/AttachedFileChip.tsx`:

```tsx
import { X } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export interface AttachedFile {
  name: string;
  path: string;
  content: string | null;
  error?: string;
}

interface Props {
  file: AttachedFile;
  onRemove: () => void;
}

export function AttachedFileChip({ file, onRemove }: Props) {
  const hasError = file.content === null;

  const chip = (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs',
        hasError
          ? 'border-rose-400/40 bg-rose-400/10 text-rose-400'
          : 'border-border-default bg-bg-elevated text-text-secondary',
      )}
    >
      <span className="max-w-[120px] truncate">{file.name}</span>
      <button
        type="button"
        onClick={onRemove}
        className="ml-0.5 rounded hover:text-text-primary"
        aria-label={`Remove ${file.name}`}
      >
        <X size={10} />
      </button>
    </span>
  );

  if (hasError) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{chip}</TooltipTrigger>
        <TooltipContent>{file.error ?? 'Unsupported format'}</TooltipContent>
      </Tooltip>
    );
  }

  return chip;
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend-react/src/components/chat/AttachedFileChip.tsx
git commit -m "feat(chat): add AttachedFileChip component"
```

---

## Task 7: Create `FileAttachButton` component

**Files:**
- Create: `frontend-react/src/components/chat/FileAttachButton.tsx`

- [ ] **Step 1: Create the component**

Create `frontend-react/src/components/chat/FileAttachButton.tsx`:

```tsx
import { Paperclip } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { AttachedFile } from './AttachedFileChip';
import { tauri } from '@/lib/tauri';

interface Props {
  onFilesSelected: (files: AttachedFile[]) => void;
}

export function FileAttachButton({ onFilesSelected }: Props) {
  const handleClick = async () => {
    const result = await open({ multiple: true });
    if (!result) return;

    const paths = Array.isArray(result) ? result : [result];

    const files: AttachedFile[] = await Promise.all(
      paths.map(async (path) => {
        const name = path.split(/[\\/]/).pop() ?? path;
        try {
          const content = await tauri.files.readAsText(path);
          return { name, path, content };
        } catch {
          return { name, path, content: null, error: 'Unsupported format' };
        }
      }),
    );

    onFilesSelected(files);
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void handleClick()}
          className="p-1.5 rounded text-text-muted hover:bg-bg-hover hover:text-text-secondary"
          aria-label="Attach file"
        >
          <Paperclip size={16} />
        </button>
      </TooltipTrigger>
      <TooltipContent>Attach file</TooltipContent>
    </Tooltip>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend-react/src/components/chat/FileAttachButton.tsx
git commit -m "feat(chat): add FileAttachButton with Tauri dialog + file reading"
```

---

## Task 8: Create `ToolsPopover` component

**Files:**
- Create: `frontend-react/src/components/chat/ToolsPopover.tsx`

- [ ] **Step 1: Create the component**

Create `frontend-react/src/components/chat/ToolsPopover.tsx`:

```tsx
import { Wrench, Search, Globe, FolderOpen, Pencil, Zap } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useUI, type ToolId } from '@/stores/ui';

const TOOLS: { id: ToolId; label: string; Icon: React.FC<{ size?: number }> }[] = [
  { id: 'web_search',   label: 'Web Search',   Icon: Search },
  { id: 'http_request', label: 'HTTP Request',  Icon: Globe },
  { id: 'file_read',    label: 'File Read',     Icon: FolderOpen },
  { id: 'file_write',   label: 'File Write',    Icon: Pencil },
  { id: 'code_execute', label: 'Code Execute',  Icon: Zap },
];

export function ToolsPopover() {
  const enabledTools = useUI((s) => s.enabledTools);
  const toggleTool = useUI((s) => s.toggleTool);
  const activeCount = enabledTools.length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'relative p-1.5 rounded hover:bg-bg-hover',
            activeCount > 0 ? 'text-brand' : 'text-text-muted hover:text-text-secondary',
          )}
          aria-label="Tools"
        >
          <Wrench size={16} />
          {activeCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-brand text-[8px] font-bold text-white leading-none">
              {activeCount}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-44">
        <DropdownMenuLabel className="text-xs text-text-muted">Tools</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {TOOLS.map(({ id, label, Icon }) => (
          <DropdownMenuCheckboxItem
            key={id}
            checked={enabledTools.includes(id)}
            onCheckedChange={() => toggleTool(id)}
            className="gap-2 text-sm"
          >
            <Icon size={13} />
            {label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

- [ ] **Step 2: Verify `DropdownMenuCheckboxItem` is exported from the existing ui component**

Check `frontend-react/src/components/ui/dropdown-menu.tsx` — it should re-export `DropdownMenuCheckboxItem` from `@radix-ui/react-dropdown-menu`. If not, add it:

```ts
// In the existing re-export list in dropdown-menu.tsx, add:
const DropdownMenuCheckboxItem = DropdownMenuPrimitive.CheckboxItem;
// and export it at the bottom
```

- [ ] **Step 3: Commit**

```bash
git add frontend-react/src/components/chat/ToolsPopover.tsx frontend-react/src/components/ui/dropdown-menu.tsx
git commit -m "feat(chat): add ToolsPopover with per-tool checkbox toggles"
```

---

## Task 9: Create `BrainButton` inline in `ChatInput` — Brain badge + colors

This task is done inside the `ChatInput` rewrite (Task 10). No separate file — the brain button logic is simple enough to live in `ChatInput`.

---

## Task 10: Rewrite `ChatInput.tsx` to wire all three buttons

**Files:**
- Modify: `frontend-react/src/components/chat/ChatInput.tsx`

- [ ] **Step 1: Rewrite `ChatInput.tsx`**

Replace the entire file with:

```tsx
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Brain, ArrowUp, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ModelSelector } from './ModelSelector';
import { AttachedFileChip, type AttachedFile } from './AttachedFileChip';
import { FileAttachButton } from './FileAttachButton';
import { ToolsPopover } from './ToolsPopover';
import { useModel } from '@/stores/model';
import { useChat } from '@/stores/chat';
import { useUI } from '@/stores/ui';
import { useSendMessage } from '@/hooks/useSendMessage';
import { tauri } from '@/lib/tauri';
import { cn } from '@/lib/utils';

const REASONING_CONFIG = {
  auto: { label: 'A',   iconClass: 'text-sky-400',     badgeClass: 'bg-gray-500/20 text-gray-400' },
  on:   { label: 'ON',  iconClass: 'text-emerald-400', badgeClass: 'bg-emerald-500/20 text-emerald-400' },
  off:  { label: 'OFF', iconClass: 'text-rose-400',    badgeClass: 'bg-rose-500/20 text-rose-400' },
} as const;

// Mobile UX (deferred): swap to Enter=newline + explicit send button.
export function ChatInput() {
  const [text, setText] = useState('');
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const loaded = useModel((s) => s.loaded);
  const status = useChat((s) => s.streamStatus);
  const reasoningMode = useUI((s) => s.reasoningMode);
  const cycleReasoningMode = useUI((s) => s.cycleReasoningMode);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const send = useSendMessage();

  // Auto-resize textarea
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [text]);

  const isStreaming = status === 'streaming';
  const disabled = !loaded;

  const trySend = async () => {
    if (!text.trim() || isStreaming || disabled) return;
    const content = text;
    const files = attachedFiles;
    setText('');
    setAttachedFiles([]);
    await send(content, files);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void trySend();
    }
  };

  const removeFile = (path: string) =>
    setAttachedFiles((prev) => prev.filter((f) => f.path !== path));

  const rc = REASONING_CONFIG[reasoningMode];

  return (
    <TooltipProvider delayDuration={300}>
      <div className="border-t border-border-subtle bg-bg-primary px-4 py-3">
        <div className="rounded-xl border border-border-default bg-bg-surface focus-within:border-brand transition-colors">
          {attachedFiles.length > 0 && (
            <div className="flex flex-wrap gap-1 px-3 pt-2">
              {attachedFiles.map((f) => (
                <AttachedFileChip
                  key={f.path}
                  file={f}
                  onRemove={() => removeFile(f.path)}
                />
              ))}
            </div>
          )}
          <Textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={loaded ? 'Ask anything…' : 'Load a model to start chatting'}
            disabled={disabled}
            rows={1}
            className="resize-none border-0 bg-transparent focus-visible:ring-0 max-h-[200px]"
          />
          <div className="flex items-center justify-between px-2 pb-2">
            <div className="flex gap-1">
              <FileAttachButton
                onFilesSelected={(files) => setAttachedFiles((prev) => [...prev, ...files])}
              />
              <ToolsPopover />
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={cycleReasoningMode}
                    className={cn('relative p-1.5 rounded hover:bg-bg-hover', rc.iconClass)}
                    aria-label={`Reasoning: ${reasoningMode}`}
                  >
                    <Brain size={16} />
                    <span
                      className={cn(
                        'absolute -bottom-0.5 -right-0.5 rounded px-[3px] text-[8px] font-bold leading-[11px]',
                        rc.badgeClass,
                      )}
                    >
                      {rc.label}
                    </span>
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  Reasoning: {reasoningMode === 'auto' ? 'Auto (detect from model)' : reasoningMode === 'on' ? 'Always on' : 'Off'}
                </TooltipContent>
              </Tooltip>
            </div>
            <div className="flex items-center gap-2">
              <ModelSelector />
              {isStreaming ? (
                <Button
                  size="icon"
                  variant="destructive"
                  onClick={() => void tauri.chat.stop()}
                  aria-label="Stop"
                  className="h-7 w-7"
                >
                  <Square size={12} />
                </Button>
              ) : (
                <Button
                  size="icon"
                  onClick={() => void trySend()}
                  disabled={!text.trim() || disabled}
                  aria-label="Send"
                  className="h-7 w-7"
                >
                  <ArrowUp size={12} />
                </Button>
              )}
            </div>
          </div>
        </div>
        {!loaded && (
          <p className="text-xs text-text-muted mt-2">
            No model loaded. Open Models to load one.
          </p>
        )}
      </div>
    </TooltipProvider>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```
cd frontend-react
npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add frontend-react/src/components/chat/ChatInput.tsx
git commit -m "feat(chat): wire file attach, tools popover, and reasoning brain button in ChatInput"
```

---

## Task 11: Update `useSendMessage` to prepend files and pass reasoning mode

**Files:**
- Modify: `frontend-react/src/hooks/useSendMessage.ts`

- [ ] **Step 1: Rewrite `useSendMessage.ts`**

Replace the entire file with:

```ts
import { useCallback } from 'react';
import { useChat, type ChatMessage } from '@/stores/chat';
import { useConversations } from '@/stores/conversations';
import { useModel } from '@/stores/model';
import { useUI } from '@/stores/ui';
import { useChatStream } from './useChatStream';
import { toIpcMessage } from '@/lib/messageMapping';
import { currentInferParams } from '@/lib/inferParams';
import { autoTitle } from '@/lib/autoTitle';
import { splitThinking } from '@/lib/parseThink';
import type { AttachedFile } from '@/components/chat/AttachedFileChip';

function buildUserContent(text: string, files: AttachedFile[]): string {
  const validFiles = files.filter((f) => f.content !== null);
  if (validFiles.length === 0) return text;
  const fileBlocks = validFiles
    .map((f) => `[File: ${f.name}]\n${f.content}`)
    .join('\n\n');
  return `${fileBlocks}\n\n${text}`;
}

function autoSaveIfEligible() {
  const chat = useChat.getState();
  const hasUser      = chat.messages.some((m) => m.role === 'user');
  const hasCompleteA = chat.messages.some((m) => m.role === 'assistant' && m.content.trim().length > 0);
  if (chat.streamStatus !== 'done' || !hasUser || !hasCompleteA) return;
  void useConversations.getState().saveCurrent(autoTitle(chat.messages));
}

export function useSendMessage() {
  const stream = useChatStream(useChat.getState().sessionId);

  return useCallback(
    async (text: string, files: AttachedFile[] = []) => {
      const chat = useChat.getState();
      const { reasoningMode } = useUI.getState();
      const loaded = useModel.getState().loaded;
      const modelName = loaded?.name ?? '';

      const content = buildUserContent(text, files);

      const userMsg = {
        id: crypto.randomUUID(),
        role: 'user' as const,
        content,
        createdAt: Date.now(),
      };
      const asstMsg = {
        id: crypto.randomUUID(),
        role: 'assistant' as const,
        content: '',
        thinkingComplete: true,
        createdAt: Date.now() + 1,
      };
      chat.addMessage(userMsg);
      chat.addMessage(asstMsg);
      chat.setStreamStatus('streaming');

      const messages = useChat.getState().messages.slice(0, -1).map(toIpcMessage);
      const params = await currentInferParams({ reasoningMode, modelName });

      let buffer = '';
      let thinkingStartAt: number | null = null;

      await stream.start(messages, params, {
        onToken: (chunk) => {
          buffer += chunk;
          const split = splitThinking(buffer);
          const patch: Partial<ChatMessage> = { content: split.answer };
          if (split.thinking !== null) {
            patch.thinking = split.thinking;
            patch.thinkingComplete = split.thinkingComplete;
            if (thinkingStartAt === null) thinkingStartAt = Date.now();
            if (split.thinkingComplete && thinkingStartAt !== null) {
              patch.thinkingDurationMs = Date.now() - thinkingStartAt;
            }
          }
          useChat.getState().updateLastAssistantMessage(patch);
        },
        onDone: () => {
          useChat.getState().setStreamStatus('done');
          autoSaveIfEligible();
        },
        onError: (err) => useChat.getState().setStreamStatus('error', err),
        onStopped: () => useChat.getState().setStreamStatus('stopped'),
      });
    },
    [stream],
  );
}
```

- [ ] **Step 2: Check what `useModel.getState().loaded` looks like**

In `frontend-react/src/stores/model.ts`, verify the `loaded` field type — it should be `LoadedModel | null` with a `name` property. If `loaded` has a different shape, adjust `loaded?.name ?? ''` accordingly.

- [ ] **Step 3: Verify TypeScript compiles**

```
cd frontend-react
npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add frontend-react/src/hooks/useSendMessage.ts
git commit -m "feat(chat): prepend attached file content and pass reasoning mode to inferParams"
```

---

## Task 12: Update `MessageItem` to suppress ThinkingBlock when reasoning = off

**Files:**
- Modify: `frontend-react/src/components/chat/MessageItem.tsx`

- [ ] **Step 1: Update `MessageItem.tsx`**

Replace the entire file with:

```tsx
import { cn } from '@/lib/utils';
import { Markdown } from '@/lib/markdown';
import { ThinkingBlock } from './ThinkingBlock';
import type { ChatMessage } from '@/stores/chat';
import { useUI } from '@/stores/ui';

export function MessageItem({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  const reasoningMode = useUI((s) => s.reasoningMode);

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] rounded-2xl rounded-tr-sm px-4 py-3 bg-bg-elevated border border-border-default">
          <p className="text-sm text-text-primary whitespace-pre-wrap break-words leading-relaxed">
            {message.content}
          </p>
        </div>
      </div>
    );
  }

  const showThinking = message.thinking != null && reasoningMode !== 'off';

  return (
    <div className="flex flex-col gap-2">
      {showThinking && (
        <ThinkingBlock
          id={message.id}
          content={message.thinking!}
          duration={message.thinkingDurationMs ? Math.round(message.thinkingDurationMs / 1000) : 0}
          active={!message.thinkingComplete}
        />
      )}
      <div className={cn('text-sm leading-relaxed', !message.content && 'hidden')}>
        <Markdown>{message.content}</Markdown>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```
cd frontend-react
npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 3: Run all tests to confirm nothing broken**

```
cd frontend-react
npx vitest run
```

Expected: all tests pass

- [ ] **Step 4: Commit**

```bash
git add frontend-react/src/components/chat/MessageItem.tsx
git commit -m "feat(chat): hide ThinkingBlock when reasoning mode is off"
```

---

## Task 13: Manual smoke test

- [ ] **Step 1: Start the dev app**

```
cd frontend-react
npm run dev
```

Then in another terminal:
```
cd src-tauri
cargo tauri dev
```

- [ ] **Step 2: Test Brain button**
  - Click Brain → should cycle A (sky) → ON (emerald) → OFF (rose) → A
  - Badge label should change with each click
  - Tooltip should describe the current state

- [ ] **Step 3: Test Wrench button**
  - Click Wrench → dropdown should open above the button
  - Toggle Web Search → checkmark appears, Wrench gets brand color + badge `1`
  - Toggle another tool → badge shows `2`
  - Untoggle all → Wrench returns to muted color, no badge
  - Reload app → tool state should persist

- [ ] **Step 4: Test Paperclip button**
  - Click paperclip → OS file picker opens
  - Select a `.txt` or `.rs` file → chip appears above textarea
  - Select an image file → chip appears with rose/error color
  - Click `×` on chip → chip disappears
  - Type a message and send with a file attached → message shows with file content prepended in chat history

- [ ] **Step 5: Test Reasoning → On with thinking model name loaded**
  - Load a model with "think" in the name
  - Set Brain to Auto → should trigger thinking system prompt (visible in responses as `<think>` blocks)
  - Set Brain to Off → thinking blocks should not render even if model emits them

---

## Spec Coverage Check

| Spec requirement | Task |
|-----------------|------|
| Paperclip opens OS file picker, any format | Task 7 |
| Files appear as chips above textarea | Task 10 |
| Error chips for binary files | Task 6 |
| Files prepended to user message on send | Task 11 |
| Files reset after send | Task 10 |
| Wrench shows tool toggles in popover | Task 8 |
| Wrench button colored when tools active + badge count | Task 8 |
| Tool state persisted in useUI | Task 1 |
| Brain cycles Auto→On→Off | Task 1 |
| Brain badge colors: sky/emerald/rose | Task 10 |
| Auto detects thinking models by name | Task 2 |
| On always adds thinking system prompt | Task 3 |
| Off suppresses ThinkingBlock render | Task 12 |
| reasoningMode + enabledTools persisted | Task 1 |
| Rust read_file_as_text command | Task 4 |
| tauri-plugin-dialog registered | Task 4 |
