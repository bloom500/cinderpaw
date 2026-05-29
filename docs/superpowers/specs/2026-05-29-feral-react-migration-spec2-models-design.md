# Feral React Migration — Spec 2: Models Page

**Date:** 2026-05-29
**Status:** Awaiting user review
**Branch:** `react-migration-spec1` (continues from spec 1)
**Depends on:** Spec 1 complete (foundation, Chat page, stores, IPC façade)

This spec migrates the Leptos Models page (1447 LOC) to React. Scope: Local Models tab, Browse HuggingFace tab, BYOK banner. The BYOK accordion is intentionally moved to spec 4 (Settings page).

---

## 1. Architecture

### 1.1 New files

```
frontend-react/src/
├── pages/
│   └── ModelsPage.tsx              # route component, tab state
├── components/models/
│   ├── SystemBar.tsx               # GPU / RAM / Vulkan info strip
│   ├── ByokBanner.tsx              # "Configure cloud providers in Settings →"
│   ├── LocalModelsTab.tsx          # grid of installed .gguf cards
│   ├── LocalModelCard.tsx          # one card: name/size/quant + actions
│   ├── BrowseTab.tsx               # search + paginated accordion list
│   ├── HfModelCard.tsx             # one result row + accordion expand
│   └── HfDetailPanel.tsx           # file list + download + readme
├── stores/
│   ├── download.ts                 # NEW: global download state
│   └── systemInfo.ts              # NEW: one-time system info fetch
└── lib/
    └── modelUtils.ts               # pure porting of Leptos helper fns
```

`ModelsPage.tsx` is thin — owns only `tab` state and renders `SystemBar`, `ByokBanner`, tabs, and the active tab component. No other logic at page level.

### 1.2 Sidebar update

In `components/layout/Sidebar.tsx`, the Models menu item becomes active:

```ts
{ icon: Box, label: 'Models', ..., disabled: false, route: '/models' }
```

The `StubPage` for `/models` is replaced by `<ModelsPage />` in `router.tsx`.

---

## 2. New stores

### 2.1 `stores/download.ts`

```ts
interface DownloadStore {
  active: {
    repoId: string;
    filename: string;
    progress: number;   // 0.0–1.0
    key: string;        // "repoId::filename"
  } | null;
  done: boolean;
  error: string | null;

  start:  (repoId: string, filename: string) => Promise<void>;
  cancel: () => Promise<void>;
  reset:  () => void;
}
```

**Critical implementation rule:** `feral://download-complete` and `feral://download-error` listeners are registered **at module scope** (outside `create()`), not inside `start()`. This ensures the store reacts to completion even if the component that called `start()` has unmounted (navigation away mid-download).

```ts
// module-level, always-on listeners
listen<DownloadCompleteEvent>('feral://download-complete', (e) => {
  useDownload.setState({ active: null, done: true, error: null });
  void useModel.getState().refresh();   // update local models list
});
listen<DownloadErrorEvent>('feral://download-error', (e) => {
  if (e.payload.cancelled) {
    useDownload.setState({ active: null, done: false, error: null });
  } else {
    useDownload.setState({ active: null, error: e.payload.error });
  }
});
listen<DownloadProgressEvent>('feral://download-progress', (e) => {
  useDownload.setState((s) =>
    s.active?.key === `${e.payload.repoId}::${e.payload.filename}`
      ? { active: { ...s.active, progress: e.payload.progress } }
      : s,
  );
});
```

`start()` calls `tauri.raw.downloadModel(repoId, filename)` and does NOT await completion — the invoke returns the download key; completion comes via events. One active download at a time enforced: `start()` throws if `active !== null`.

### 2.2 `stores/systemInfo.ts`

```ts
interface SystemInfoStore {
  info: SystemInfo | null;
  loading: boolean;
  fetch: () => Promise<void>;
}
```

Fetched once on mount via `useEffect` in `ModelsPage`. Non-blocking — Models page renders immediately; system bar fills in when data arrives. Used by both `SystemBar` and `HfDetailPanel` (for `pickFittedFile` recommendation) without prop-drilling.

---

## 3. `lib/modelUtils.ts` — pure utility functions

All ported from Leptos `models.rs`. All pure (no side effects), fully unit-tested.

```ts
// Quantization quality rank — higher = better quality
// Use a named map, not inline numbers, for readability and future extension
export const QUANT_RANK: Record<string, number> = {
  f32: 110, f16: 100, fp16: 100, bf16: 100,
  q8_0: 80, q8: 80,
  q6_k: 70, q6: 70,
  q5_k_m: 62, q5_k: 60, q5: 58,
  q4_k_m: 55, q4_k: 52, q4_0: 40, q4: 40,
  q3_k_m: 35, q3_k: 32, q3: 30,
  iq2: 20, q2_k: 20, q2: 18,
  iq1: 10, q1: 8,
};

export function quantQualityRank(filename: string): number {
  const quant = extractQuant(filename).toLowerCase();
  return QUANT_RANK[quant] ?? 35;
}

export function extractQuant(filename: string): string { ... }
export function cleanModelName(filename: string): string { ... }
export function quantToQuality(quant: string): string { ... }
export function quantToBadge(quant: string): { label: string; variant: 'full' | 'high' | 'balanced' | 'small' | 'tiny' } { ... }
export function sizeGb(bytes: number): string { ... }
export function fmtNum(n: number): string { ... }   // "125.3K", "1.2M"
export function fmtDate(iso: string): string { ... } // "2024-11-15"
export function shortRepo(id: string): string { ... } // "TheBloke/X" → "X"
export function stripFrontmatter(md: string): string { ... } // strips YAML --- ... ---

// Smart file recommendation
export function pickFittedFile(files: HfFile[], sys: SystemInfo | null): HfFile | null { ... }
export function globalFittedQuant(sys: SystemInfo | null): string { ... }

type Compat = 'fits' | 'slow' | 'no';
export function compatLevel(bytes: number, sys: SystemInfo | null): Compat | null { ... }
```

`QUANT_RANK` is exported so callers can extend or reference it directly (satisfies the "proper ranked enum" note from §2 review).

---

## 4. Page composition

### 4.1 `ModelsPage`

```tsx
export function ModelsPage() {
  const [tab, setTab] = useState<'local' | 'browse'>('local');

  useEffect(() => {
    void useSystemInfo.getState().fetch();
    void useModel.getState().refresh();
  }, []);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <SystemBar />
      <ByokBanner />
      <div className="flex gap-0 px-4 pt-4 border-b border-border-subtle shrink-0">
        <TabButton active={tab === 'local'}  onClick={() => setTab('local')}>Local Models</TabButton>
        <TabButton active={tab === 'browse'} onClick={() => setTab('browse')}>Browse HuggingFace</TabButton>
      </div>
      <div className="flex-1 overflow-hidden">
        {tab === 'local'  ? <LocalModelsTab onBrowse={() => setTab('browse')} /> : null}
        {tab === 'browse' ? <BrowseTab />                                         : null}
      </div>
    </div>
  );
}
```

Conditional render (not CSS hidden) keeps Browse tab state fresh on first open and discarded when switching away — consistent with Leptos behavior.

### 4.2 `SystemBar`

Reads from `useSystemInfo`. Renders only when `info !== null`. Single line:

```
NVIDIA RTX 3070  ·  8 GB VRAM  ·  32 GB RAM  ·  Vulkan ✓
```

All text in `text-text-secondary`, "Vulkan ✓" in `text-success`. Absent gracefully (returns `null`) if info unavailable. No spinner — the bar simply appears once data arrives.

### 4.3 `ByokBanner`

Always visible, above both tabs. One line, clickable, navigates to `/settings`:

```
☁  Want to use cloud AI? Configure OpenAI, Anthropic and others in Settings → BYOK
```

```tsx
<button onClick={() => navigate('/settings')}
  className="w-full flex items-center gap-2 px-4 py-2 bg-bg-surface text-text-muted text-sm hover:bg-bg-hover transition-colors">
  <Cloud size={14} />
  <span>Want to use cloud AI? Configure OpenAI, Anthropic and others in</span>
  <span className="text-brand font-medium">Settings → BYOK</span>
  <ChevronRight size={12} />
</button>
```

No hardcoded colors — only CSS vars via Tailwind utility names.

---

## 5. Local Models tab

### 5.1 `LocalModelsTab`

Reads `useModel.loaded`, `useModel.isLoading`, `useModel.loadProgress` from the existing store. Fetches local model list via `tauri.models.list()` on mount. Listens to `feral://download-complete` to refresh after downloads (via `useDownload` store's module-level listener calling `useModel.refresh()`).

Responsive grid: `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`.

Empty state:
```
No models installed yet.
Switch to Browse HuggingFace to download your first model.
          [Browse HuggingFace →]
```
The button calls `onBrowse()` prop (switches tab at page level, no navigation).

### 5.2 `LocalModelCard`

Four mutually exclusive states:

**Idle:**
```
┌────────────────────────────────────┐
│ Llama 3.1 8B Instruct              │
│ 4.7 GB · Balanced quality          │
│                     [Load] [Delete] │
└────────────────────────────────────┘
```

**Loading (this card's path matches `useModel.isLoading`):**
```
┌────────────────────────────────────┐
│ Llama 3.1 8B Instruct              │
│ 4.7 GB · Balanced quality          │
│ Warming KV cache...          75%   │
│ ██████████████░░░░░░░░░░░░░░░░░    │
└────────────────────────────────────┘
```

**Loaded (Active):**
```
┌────────────────────────────────────┐
│ Llama 3.1 8B Instruct     ● Active │  ← brand color badge
│ 4.7 GB · Balanced quality          │
│               [Unload] [Delete]    │
└────────────────────────────────────┘
```

**Deleting:**
```
│               [Load]  [⠼ Deleting] │  ← Load disabled, spinner
```

**Delete flow:** unload first if currently loaded (fires `tauri.models.unload()`), then delete (fires `tauri.models.delete(path)`). Prevents Windows file-lock error. Local `isDeleting: boolean` state in the card.

`quantToBadge` variant → Tailwind class map (no hardcoded hex):
- `full` → `text-text-secondary bg-bg-elevated`
- `high` → `text-success`
- `balanced` → `text-brand`
- `small` / `tiny` → `text-text-muted`

---

## 6. Browse HuggingFace tab

### 6.1 `BrowseTab` local state

```ts
const [query, setQuery]                       = useState('');
const [results, setResults]                   = useState<HfModelSummary[]>([]);
const [nextCursor, setNextCursor]             = useState<string | null>(null);
const [loading, setLoading]                   = useState(false);
const [error, setError]                       = useState<string | null>(null);
const [selectedRepoId, setSelectedRepoId]     = useState<string | null>(null);
const [detail, setDetail]                     = useState<HfModelDetail | null>(null);
const [detailLoading, setDetailLoading]       = useState(false);
const [popularLoaded, setPopularLoaded]       = useState(false);
```

On mount (first open): if `!popularLoaded`, fetch trending (`query: ''`). Uses `useEffect` with `popularLoaded` guard — fires once only.

### 6.2 Search toolbar

```
[⌕ Search models on HuggingFace...]  [Search]
```

Enter key or button fires search. Empty query → trending (most-downloaded GGUF). Non-empty → relevance search. Results replace current list; cursor resets.

### 6.3 `HfModelCard`

Collapsed row (always rendered):
```
TheBloke/Llama-3.1-8B-GGUF                               ▸
⬇ 125.3K  ♥ 892  2024-11-15  · gguf · text-generation
```

Chevron rotates 90° on expand (Framer motion `animate={{ rotate: expanded ? 90 : 0 }}`).

Clicking a card: sets `selectedRepoId`, fetches `get_hf_model_detail`, sets `detail`. Only one card expanded at a time — expanding a card collapses the previous.

Expand/collapse uses Framer `AnimatePresence` with `height: 'auto'` animation (~200ms).

### 6.4 `HfDetailPanel`

Renders inside the expanded `HfModelCard` (not a separate column).

**File list:** radio-style rows. Each row:
```
○  Llama-3.1-8B.Q4_K_M.gguf   4.7 GB   [Balanced] ★ Recommended
○  Llama-3.1-8B.Q8_0.gguf     8.5 GB   [High]
○  Llama-3.1-8B.F16.gguf      16.2 GB  [Full]
```

- `★ Recommended` pill on the auto-selected file (from `pickFittedFile(files, systemInfo)`)
- File size from `HfFile.size`; if null, fires `tauri.raw.getModelSizeInfo(repoId, filename)` lazily (per-file HEAD request, same as Leptos)
- Quality badge colored via `quantToBadge()` → CSS var classes

**Action button states** (mutually exclusive):

| State | Condition | UI |
|---|---|---|
| No file selected | `selectedFile === null` | Disabled "Install Model Locally" |
| File selected, not installed | file not in local models | Enabled "Install Model Locally" → `useDownload.start()` |
| Downloading (this repo) | `download.active?.repoId === repoId` | Progress bar + percent + Cancel button |
| Download complete | `download.done && selectedFile installed` | ✓ "Model installed successfully" (2s), then "Load model" |
| Already installed | file.rfilename in local models | "Load model" → `useModel.load(path)` → navigate to `/chat` |

"Already installed" check: `localModels.find(m => m.name === selectedFile.rfilename)`. Local models list read from `useModel` store (refreshed by `download.ts` module-level listener after completion).

**README:** rendered via existing `<Markdown>` component. `stripFrontmatter()` called before passing to `<Markdown>`. Wrapped in shadcn `<Collapsible>` with "README ▸" toggle header — collapsed by default.

**detailLoading state:** while fetching `get_hf_model_detail`, show 3-dot `<StreamingIndicator />` (reused from Chat) in place of the panel body.

### 6.5 Pagination

"Load more" button at bottom of results list, visible when `nextCursor !== null`. Appends to `results` (does not replace). Shares the `loading` state with search — button disabled while loading.

---

## 7. Testing

### 7.1 Unit tests — `lib/modelUtils.test.ts`

| Function | Test cases |
|---|---|
| `cleanModelName` | Strips `.gguf`; strips quant suffix; title-cases `-`/`_` separated segments; no double spaces |
| `quantToQuality` | Q4_K_M → "Balanced quality"; Q8_0 → "Best quality"; F16 → "Full precision"; unknown → "Standard"; case-insensitive |
| `quantToBadge` | Correct `{ label, variant }` for each tier; case-insensitive |
| `quantQualityRank` | Q4_K_M(55) > Q4_0(40); Q8_0(80) > Q6_K(70); F16=100; unknown=35; uses `QUANT_RANK` map |
| `sizeGb` | < 1 GB returns MB; ≥ 1 GB returns GB with 1 decimal |
| `pickFittedFile` | Empty → null; all fit → highest rank; none comfortable → smallest slow; all too big → smallest |
| `globalFittedQuant` | Correct tier at 4096 / 8192 / 12288 / 24576 / 32768 MB VRAM thresholds |
| `stripFrontmatter` | Strips `--- ... ---`; no-op if no frontmatter; preserves content after frontmatter |

Target ~90% line coverage. Zero mocks needed (pure functions).

### 7.2 Component tests — `LocalModelCard.test.tsx`

Behavior-coverage (not line %), all listed behaviors must have at least one assertion:

- Idle: Load + Delete buttons visible; no progress bar
- Loading (path matches): progress bar renders with correct percent; Load + Delete hidden
- Loaded (Active): "Active" badge visible with `text-brand` class; Unload + Delete visible; Load absent
- Deleting: Delete button shows spinner; Load button disabled

### 7.3 Manual DoD checklist

**Setup**
- [ ] `npm run typecheck` 0 errors after all new files
- [ ] `npm run test:ci` all passing (prior 16 + new modelUtils + LocalModelCard)
- [ ] `grep -rn "#[0-9a-fA-F]" frontend-react/src/components/models/` returns zero hits (no hardcoded hex in new component files)

**Sidebar**
- [ ] "Models" menu item is clickable (no lock icon, no "Coming soon" tooltip)
- [ ] Clicking navigates to `/models` route

**System bar**
- [ ] Appears after data arrives (no layout jump if slow)
- [ ] Shows GPU name, VRAM GB, RAM GB, Vulkan status
- [ ] Absent gracefully if `get_system_info` fails

**ByokBanner**
- [ ] Visible above both tabs
- [ ] Click navigates to `/settings`
- [ ] Text uses CSS vars only (no hardcoded colors)

**Local Models tab**
- [ ] Empty state shows with "Browse HuggingFace →" button that switches tab
- [ ] Installed models show correct cleaned name, size, quant quality
- [ ] Load → progress bar animates, "Active" badge appears after load
- [ ] Load does NOT navigate away (stays on Models page)
- [ ] Unload → card returns to idle
- [ ] Delete loaded model → unloads first, then deletes, card disappears (no file-lock error)
- [ ] Delete non-loaded model → deletes immediately, card disappears
- [ ] Responsive grid: 1 col narrow, 2 col medium, 3 col wide
- [ ] Both light + dark mode: no hardcoded colors visible

**Browse tab**
- [ ] Opens with trending models (no search needed on first open)
- [ ] Re-opening Browse tab after switching away does NOT re-fetch
- [ ] Search "llama" → results update
- [ ] Empty search → trending results (most downloaded)
- [ ] "Load more" appends to list, not replaces
- [ ] Click card → expands; previous card collapses
- [ ] `detailLoading` spinner shows while fetching detail
- [ ] Recommended file auto-selected; "★ Recommended" pill visible
- [ ] File sizes load (HEAD request fires for null-size files)
- [ ] Quality badges match quant tier (Balanced/High/Full/Small/Tiny)
- [ ] Download → progress bar 0→100% with percent; Cancel stops download
- [ ] Download cancelled → no error shown, card returns to install state
- [ ] After download complete → ✓ success message, then "Load model" appears
- [ ] "Load model" from Browse → navigates to `/chat` after load completes
- [ ] "Load model" from Local → stays on Models page
- [ ] README renders via `<Markdown>`, frontmatter stripped, collapsed by default
- [ ] README expand/collapse works
- [ ] Both light + dark mode: all components correct

**Hardcoded color check**
- [ ] `grep -rn "#[0-9a-fA-F]" frontend-react/src/components/models/` → zero hits

---

## 8. Out of scope for spec 2

- BYOK provider accordion (moves to spec 4 Settings)
- Model filter/sort controls on Local tab (deferred; `quantQualityRank` exported for when it lands)
- Modelfile editor (not in Leptos either)
- Multi-download queue (one at a time enforced)
