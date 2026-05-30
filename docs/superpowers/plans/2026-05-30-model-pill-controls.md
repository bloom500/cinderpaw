# Model Pill + Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the detached `ChatHeader` top bar with a seamlessly integrated header containing a large `ModelPill` button that surfaces model selection and inference parameter controls.

**Architecture:** Add `inferParams` state to the model store and wire it into `inferParams.ts`; extract model-picking logic into `ModelPickerPopover`; build a new `ControlsPopover` with Temperature/Top-P/Max-Tokens sliders backed by `@radix-ui/react-popover`; compose both into `ModelPill`; redesign `ChatHeader` to use the pill; remove `ModelSelector` from `ChatInput`.

**Tech Stack:** React 18, Zustand, Radix UI, Tailwind CSS, shadcn/ui conventions, Tauri IPC

---

## File Map

| Action | File |
|--------|------|
| Create | `frontend-react/src/components/ui/popover.tsx` |
| Modify | `frontend-react/package.json` |
| Modify | `frontend-react/src/stores/model.ts` |
| Modify | `frontend-react/src/lib/inferParams.ts` |
| Create | `frontend-react/src/components/chat/ModelPickerPopover.tsx` |
| Create | `frontend-react/src/components/chat/ControlsPopover.tsx` |
| Create | `frontend-react/src/components/chat/ModelPill.tsx` |
| Modify | `frontend-react/src/components/chat/ChatHeader.tsx` |
| Modify | `frontend-react/src/components/chat/ChatInput.tsx` |
| Delete | `frontend-react/src/components/chat/ModelSelector.tsx` |

---

## Task 1: Add Radix Popover dependency and create ui/popover.tsx

**Files:**
- Modify: `frontend-react/package.json`
- Create: `frontend-react/src/components/ui/popover.tsx`

- [ ] **Step 1: Install the package**

Run from `frontend-react/`:
```
npm install @radix-ui/react-popover@^1.1.7
```
Expected: package added to `node_modules`, version entry appears in `package.json` under `dependencies`.

- [ ] **Step 2: Create the shadcn-style Popover wrapper**

Create `frontend-react/src/components/ui/popover.tsx`:
```tsx
import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cn } from '@/lib/utils';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;

export const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = 'center', sideOffset = 4, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        'z-50 rounded-md border bg-popover p-3 text-popover-foreground shadow-md outline-none',
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        'data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2',
        className
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;
```

- [ ] **Step 3: Verify TypeScript compiles**

Run from `frontend-react/`:
```
npx tsc --noEmit
```
Expected: no errors related to `popover.tsx`.

- [ ] **Step 4: Commit**

```bash
git add frontend-react/package.json frontend-react/package-lock.json frontend-react/src/components/ui/popover.tsx
git commit -m "feat(ui): add Radix Popover shadcn wrapper"
```

---

## Task 2: Add inferParams state to model store and wire inferParams.ts

**Files:**
- Modify: `frontend-react/src/stores/model.ts`
- Modify: `frontend-react/src/lib/inferParams.ts`

- [ ] **Step 1: Add InferParamsUI type and state to stores/model.ts**

Replace the full contents of `frontend-react/src/stores/model.ts` with:
```ts
import { create } from 'zustand';
import { tauri, events, type LoadedModel } from '@/lib/tauri';

type UnlistenFn = () => void;

export interface CloudModel {
  providerId: string;
  providerName: string;
  modelId: string;
}

export interface InferParamsUI {
  temperature: number;
  top_p: number;
  max_tokens: number;
}

interface ModelStore {
  loaded: LoadedModel | null;
  isLoading: boolean;
  loadProgress: { percentage: number; statusText: string } | null;
  cloudModel: CloudModel | null;
  inferParams: InferParamsUI;

  refresh: () => Promise<void>;
  load:    (path: string) => Promise<void>;
  unload:  () => Promise<void>;
  setCloudModel: (m: CloudModel | null) => void;
  setInferParams: (patch: Partial<InferParamsUI>) => void;
}

let progressUnlisten: UnlistenFn | null = null;

export const useModel = create<ModelStore>((set) => ({
  loaded: null,
  isLoading: false,
  loadProgress: null,
  cloudModel: null,
  inferParams: { temperature: 0.8, top_p: 0.95, max_tokens: 2048 },

  refresh: async () => {
    const loaded = await tauri.models.loaded();
    set({ loaded });
  },

  load: async (path) => {
    set({ isLoading: true, loadProgress: { percentage: 0, statusText: 'Initializing...' } });
    if (progressUnlisten) { progressUnlisten(); progressUnlisten = null; }
    progressUnlisten = await events.modelLoadProgressEvent.listen((e) => {
      set({ loadProgress: { percentage: e.payload.percentage, statusText: e.payload.statusText } });
    });
    try {
      const loaded = await tauri.models.startLoad(path);
      set({ loaded, isLoading: false, loadProgress: null });
    } catch (err) {
      set({ isLoading: false, loadProgress: null });
      throw err;
    } finally {
      if (progressUnlisten) { progressUnlisten(); progressUnlisten = null; }
    }
  },

  unload: async () => {
    await tauri.models.unload();
    set({ loaded: null });
  },

  setCloudModel: (cloudModel) => set({ cloudModel }),
  setInferParams: (patch) => set((s) => ({ inferParams: { ...s.inferParams, ...patch } })),
}));
```

- [ ] **Step 2: Update lib/inferParams.ts to read from store**

Replace the full contents of `frontend-react/src/lib/inferParams.ts` with:
```ts
import { tauri, type InferParams, type Settings } from '@/lib/tauri';
import { modelSupportsThinking } from '@/lib/modelUtils';
import type { ReasoningMode } from '@/stores/ui';
import { useModel } from '@/stores/model';

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
  enabledTools?: string[];
}): Promise<InferParams> {
  await ensureSettingsLoaded();

  const mode = opts?.reasoningMode ?? 'auto';
  const name = opts?.modelName ?? '';
  const { temperature, top_p, max_tokens } = useModel.getState().inferParams;

  const enableThinking =
    mode === 'on' ||
    (mode === 'auto' && modelSupportsThinking(name));

  const tools = opts?.enabledTools?.length ? opts.enabledTools : null;

  return {
    temperature,
    top_p,
    repeat_penalty: 1.1,
    max_tokens,
    system_prompt: enableThinking ? THINKING_SYSTEM_PROMPT : null,
    tools,
  };
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run from `frontend-react/`:
```
npx tsc --noEmit
```
Expected: no errors in `stores/model.ts` or `lib/inferParams.ts`.

- [ ] **Step 4: Commit**

```bash
git add frontend-react/src/stores/model.ts frontend-react/src/lib/inferParams.ts
git commit -m "feat(store): add inferParams state to model store, read from store in inferParams.ts"
```

---

## Task 3: Create ModelPickerPopover

**Files:**
- Create: `frontend-react/src/components/chat/ModelPickerPopover.tsx`

This extracts the dropdown content from the old `ModelSelector` into a standalone component that will be used as the left trigger section of `ModelPill`.

- [ ] **Step 1: Create the file**

Create `frontend-react/src/components/chat/ModelPickerPopover.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { ChevronDown, Cloud, HardDrive } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useModel } from '@/stores/model';
import { tauri, type ModelInfo, type ByokProvider } from '@/lib/tauri';

function formatBytes(n: number): string {
  if (n > 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n > 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

export function ModelPickerPopover() {
  const loaded        = useModel((s) => s.loaded);
  const isLoading     = useModel((s) => s.isLoading);
  const progress      = useModel((s) => s.loadProgress);
  const load          = useModel((s) => s.load);
  const cloudModel    = useModel((s) => s.cloudModel);
  const setCloudModel = useModel((s) => s.setCloudModel);

  const [localModels, setLocalModels]     = useState<ModelInfo[]>([]);
  const [cloudProviders, setCloudProviders] = useState<ByokProvider[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    void tauri.models.list().then(setLocalModels).catch(() => {});
    void tauri.raw.getByokSettings()
      .then((providers) => setCloudProviders(providers.filter((p) => p.enabled && p.has_api_key)))
      .catch(() => {});
  }, [open]);

  let label: string;
  if (isLoading) {
    label = `Loading ${progress?.percentage.toFixed(0) ?? 0}%`;
  } else if (cloudModel) {
    label = `${cloudModel.modelId} · ${cloudModel.providerName}`;
  } else {
    label = loaded?.name ?? 'No model selected';
  }

  const hasLocal = localModels.length > 0;
  const hasCloud = cloudProviders.length > 0;

  return (
    <DropdownMenu onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-1.5 h-full px-3 text-xs text-text-secondary hover:text-text-primary transition-colors outline-none">
          <span className="truncate max-w-[180px]">{label}</span>
          <ChevronDown size={11} className="shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {hasLocal && (
          <>
            <DropdownMenuLabel className="flex items-center gap-1.5 text-xs text-text-muted">
              <HardDrive size={11} /> Local
            </DropdownMenuLabel>
            {localModels.map((m) => (
              <DropdownMenuItem
                key={m.path as unknown as string}
                onClick={() => { setCloudModel(null); void load(m.path as unknown as string); }}
                className="flex flex-col items-start gap-0.5"
              >
                <span className="text-text-primary">{m.name}</span>
                <span className="text-xs text-text-muted">{formatBytes(m.size_bytes)}</span>
              </DropdownMenuItem>
            ))}
          </>
        )}
        {hasCloud && (
          <>
            {hasLocal && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="flex items-center gap-1.5 text-xs text-text-muted">
              <Cloud size={11} /> Cloud
            </DropdownMenuLabel>
            {cloudProviders.map((p) => {
              const modelId = p.default_model ?? '';
              return (
                <DropdownMenuItem
                  key={p.id}
                  disabled={!modelId}
                  onClick={() => {
                    if (!modelId) return;
                    setCloudModel({ providerId: p.id, providerName: p.name, modelId });
                  }}
                  className="flex flex-col items-start gap-0.5"
                >
                  <span className="text-text-primary">{p.name}</span>
                  <span className="text-xs text-text-muted">
                    {modelId || 'Set a default model in Settings → Cloud Keys'}
                  </span>
                </DropdownMenuItem>
              );
            })}
          </>
        )}
        {!hasLocal && !hasCloud && (
          <DropdownMenuItem disabled>
            No models found — download one or add a cloud key
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run from `frontend-react/`:
```
npx tsc --noEmit
```
Expected: no errors in `ModelPickerPopover.tsx`.

- [ ] **Step 3: Commit**

```bash
git add frontend-react/src/components/chat/ModelPickerPopover.tsx
git commit -m "feat(chat): add ModelPickerPopover extracted from ModelSelector"
```

---

## Task 4: Create ControlsPopover

**Files:**
- Create: `frontend-react/src/components/chat/ControlsPopover.tsx`

- [ ] **Step 1: Create the file**

Create `frontend-react/src/components/chat/ControlsPopover.tsx`:
```tsx
import { Settings2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useModel, type InferParamsUI } from '@/stores/model';

function ParamRow({
  label,
  value,
  min,
  max,
  step,
  decimals,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  decimals: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="mb-4 last:mb-0">
      <div className="flex justify-between items-center mb-1.5">
        <span className="text-xs text-text-secondary">{label}</span>
        <input
          type="number"
          value={decimals === 0 ? String(value) : value.toFixed(decimals)}
          min={min}
          max={max}
          step={step}
          className="w-16 text-right text-xs bg-transparent border-none outline-none text-text-primary [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          onChange={(e) => {
            const v = decimals === 0 ? parseInt(e.target.value, 10) : parseFloat(e.target.value);
            if (!isNaN(v) && v >= min && v <= max) onChange(v);
          }}
        />
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const v = decimals === 0 ? parseInt(e.target.value, 10) : parseFloat(e.target.value);
          onChange(v);
        }}
        className="w-full h-1 rounded-full appearance-none bg-white/10 cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white/80 [&::-webkit-slider-thumb]:cursor-pointer"
      />
    </div>
  );
}

const ROWS: Array<{
  key: keyof InferParamsUI;
  label: string;
  min: number;
  max: number;
  step: number;
  decimals: number;
}> = [
  { key: 'temperature', label: 'Temperature', min: 0,    max: 2,    step: 0.01,  decimals: 2 },
  { key: 'top_p',       label: 'Top-P',        min: 0.01, max: 1,    step: 0.01,  decimals: 2 },
  { key: 'max_tokens',  label: 'Max Tokens',   min: 128,  max: 8192, step: 128,   decimals: 0 },
];

export function ControlsPopover() {
  const inferParams    = useModel((s) => s.inferParams);
  const setInferParams = useModel((s) => s.setInferParams);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="flex items-center justify-center h-full px-2.5 text-text-muted hover:text-text-secondary transition-colors outline-none">
          <Settings2 size={12} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-60">
        <p className="text-xs font-medium text-text-secondary mb-3">Controls</p>
        {ROWS.map(({ key, label, min, max, step, decimals }) => (
          <ParamRow
            key={key}
            label={label}
            value={inferParams[key]}
            min={min}
            max={max}
            step={step}
            decimals={decimals}
            onChange={(v) => setInferParams({ [key]: v })}
          />
        ))}
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run from `frontend-react/`:
```
npx tsc --noEmit
```
Expected: no errors in `ControlsPopover.tsx`.

- [ ] **Step 3: Commit**

```bash
git add frontend-react/src/components/chat/ControlsPopover.tsx
git commit -m "feat(chat): add ControlsPopover with Temperature, Top-P, Max Tokens sliders"
```

---

## Task 5: Create ModelPill

**Files:**
- Create: `frontend-react/src/components/chat/ModelPill.tsx`

- [ ] **Step 1: Create the file**

Create `frontend-react/src/components/chat/ModelPill.tsx`:
```tsx
import { ModelPickerPopover } from './ModelPickerPopover';
import { ControlsPopover } from './ControlsPopover';

export function ModelPill() {
  return (
    <div className="flex items-center h-8 rounded-full bg-zinc-800/60 border border-white/10 overflow-hidden shrink-0">
      <ModelPickerPopover />
      <div className="w-px h-4 bg-white/10 shrink-0" />
      <ControlsPopover />
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run from `frontend-react/`:
```
npx tsc --noEmit
```
Expected: no errors in `ModelPill.tsx`.

- [ ] **Step 3: Commit**

```bash
git add frontend-react/src/components/chat/ModelPill.tsx
git commit -m "feat(chat): add ModelPill composing ModelPickerPopover + ControlsPopover"
```

---

## Task 6: Redesign ChatHeader

**Files:**
- Modify: `frontend-react/src/components/chat/ChatHeader.tsx`

- [ ] **Step 1: Rewrite ChatHeader**

Replace the full contents of `frontend-react/src/components/chat/ChatHeader.tsx`:
```tsx
import { useConversations } from '@/stores/conversations';
import { ModelPill } from './ModelPill';

export function ChatHeader() {
  const currentId = useConversations((s) => s.currentId);
  const list      = useConversations((s) => s.list);
  const current   = list?.find((c) => c.id === currentId);

  return (
    <div className="h-12 px-3 flex items-center gap-3 shrink-0 border-b border-white/5">
      <ModelPill />
      <span className="text-sm text-text-muted/50 truncate flex-1 min-w-0">
        {current?.title ?? 'New chat'}
      </span>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run from `frontend-react/`:
```
npx tsc --noEmit
```
Expected: no errors in `ChatHeader.tsx`.

- [ ] **Step 3: Commit**

```bash
git add frontend-react/src/components/chat/ChatHeader.tsx
git commit -m "feat(chat): redesign ChatHeader with ModelPill, remove heavy border"
```

---

## Task 7: Remove ModelSelector from ChatInput and delete ModelSelector.tsx

**Files:**
- Modify: `frontend-react/src/components/chat/ChatInput.tsx`
- Delete: `frontend-react/src/components/chat/ModelSelector.tsx`

- [ ] **Step 1: Remove ModelSelector import and usage from ChatInput.tsx**

In `frontend-react/src/components/chat/ChatInput.tsx`, remove the import line:
```ts
import { ModelSelector } from './ModelSelector';
```

Then find the JSX usage (around line 171):
```tsx
              <ModelSelector />
```
and delete that line entirely.

- [ ] **Step 2: Delete ModelSelector.tsx**

```bash
rm frontend-react/src/components/chat/ModelSelector.tsx
```

- [ ] **Step 3: Verify TypeScript compiles clean**

Run from `frontend-react/`:
```
npx tsc --noEmit
```
Expected: zero errors. No references to `ModelSelector` remain.

- [ ] **Step 4: Verify no remaining imports**

Run from `frontend-react/`:
```
grep -r "ModelSelector" src/
```
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add frontend-react/src/components/chat/ChatInput.tsx
git rm frontend-react/src/components/chat/ModelSelector.tsx
git commit -m "feat(chat): remove ModelSelector from ChatInput, delete obsolete file"
```

---

## Task 8: Manual smoke test

**Files:** none (verification only)

- [ ] **Step 1: Start the dev build**

Run from the repo root:
```
npm run tauri dev
```
Or if using a different dev command:
```
cd frontend-react && npm run dev
```

- [ ] **Step 2: Verify the pill renders**

Open the app. Confirm:
- Top bar is borderless / very subtle border
- A pill is visible top-left with "No model selected" text and a gear icon
- Conversation title appears to the right, dimmed

- [ ] **Step 3: Verify model picker**

Click the left section of the pill (model name + chevron). Confirm:
- Dropdown opens with Local / Cloud sections
- Selecting a model closes the dropdown and updates the pill label to the model name

- [ ] **Step 4: Verify controls popover**

Click the gear icon (⚙) in the pill. Confirm:
- Popover opens with "Controls" heading
- Three rows: Temperature (0.8), Top-P (0.95), Max Tokens (2048)
- Dragging a slider updates the number input in real-time
- Editing the number input updates the slider

- [ ] **Step 5: Verify inference params are used**

With a model loaded, change Temperature to 0.0 and send a message. The response should be deterministic/repetitive (low temperature). Change to 1.5 and send the same message — the response should be more varied/creative. This confirms the params reach the llama.cpp sampler.

- [ ] **Step 6: Verify reasoning mode still works in input bar**

Confirm the Brain icon reasoning mode toggle is still present in the chat input bar.
