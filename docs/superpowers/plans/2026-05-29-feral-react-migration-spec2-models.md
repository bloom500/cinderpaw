# Feral React Migration — Spec 2: Models Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the Leptos Models page (1447 LOC) to React — Local Models grid with load/unload/delete, Browse HuggingFace with accordion search/download flow, and a BYOK banner linking to Settings.

**Architecture:** New `stores/download.ts` with module-level event listeners (outlives navigation), `stores/systemInfo.ts` for one-time GPU/RAM fetch, `lib/modelUtils.ts` for pure Leptos-ported helpers, and 7 new components under `components/models/`. Sidebar Models item un-locked, StubPage replaced.

**Tech Stack:** React 18, Zustand 5, Framer Motion 11, lucide-react, shadcn Collapsible, existing `<Markdown>` + `<StreamingIndicator>` components, `@tauri-apps/api` invoke + listen.

**Spec:** `docs/superpowers/specs/2026-05-29-feral-react-migration-spec2-models-design.md`

---

## File Map

| File | Action |
|---|---|
| `frontend-react/src/lib/modelUtils.ts` | Create |
| `frontend-react/src/lib/__tests__/modelUtils.test.ts` | Create |
| `frontend-react/src/lib/tauri/index.ts` | Modify — add download + HF + sysinfo commands |
| `frontend-react/src/stores/download.ts` | Create |
| `frontend-react/src/stores/systemInfo.ts` | Create |
| `frontend-react/src/components/models/SystemBar.tsx` | Create |
| `frontend-react/src/components/models/ByokBanner.tsx` | Create |
| `frontend-react/src/components/models/LocalModelsTab.tsx` | Create |
| `frontend-react/src/components/models/LocalModelCard.tsx` | Create |
| `frontend-react/src/components/models/__tests__/LocalModelCard.test.tsx` | Create |
| `frontend-react/src/components/models/BrowseTab.tsx` | Create |
| `frontend-react/src/components/models/HfModelCard.tsx` | Create |
| `frontend-react/src/components/models/HfDetailPanel.tsx` | Create |
| `frontend-react/src/pages/ModelsPage.tsx` | Create |
| `frontend-react/src/router.tsx` | Modify — swap StubPage for ModelsPage |
| `frontend-react/src/components/layout/Sidebar.tsx` | Modify — unlock Models item |

---

## Task 1: Extend IPC façade with missing download + HF + sysinfo commands

**Files:**
- Modify: `frontend-react/src/lib/tauri/index.ts`

- [ ] **Step 1: Add missing types to `index.ts`**

In `frontend-react/src/lib/tauri/index.ts`, find the type definitions block (around line 37) and add after the existing `ModelInfo` type:

```ts
export interface HfModelSummary {
  id: string;
  author: string;
  downloads: number;
  likes: number;
  lastModified: string;
  tags: string[];
}

export interface HfFile {
  rfilename: string;
  size: number | null;
}

export interface HfModelDetail {
  id: string;
  author: string;
  downloads: number;
  likes: number;
  lastModified: string;
  tags: string[];
  ggufFiles: HfFile[];
  readme: string | null;
}

export interface HfSearchPage {
  models: HfModelSummary[];
  nextCursor: string | null;
}
```

- [ ] **Step 2: Add missing raw commands to the `raw` object**

In the same file, find the `raw` object (starts around `const raw = {`) and add these missing commands after `getSystemInfo`:

```ts
  downloadModel: (repoId: string, filename: string) =>
    invoke<Result<string, string>>('download_model', { repo_id: repoId, filename }),
  cancelDownload: (modelId: string) =>
    invoke<Result<void, string>>('cancel_download', { model_id: modelId }),
  getModelSizeInfo: (repoId: string, filename: string) =>
    invoke<Result<number, string>>('get_model_size_info', { repo_id: repoId, filename }),
  searchHfModels: (query: string, cursor?: string | null) =>
    invoke<Result<HfSearchPage, string>>('search_hf_models', { query, cursor: cursor ?? null }),
  getHfModelDetail: (repoId: string) =>
    invoke<Result<HfModelDetail, string>>('get_hf_model_detail', { repo_id: repoId }),
  getSystemInfo: () => invoke<SystemInfo>('get_system_info'),
```

**Note:** Replace the existing `getSystemInfo` line (which currently returns `invoke<object>`) with the typed version above. Also update `searchHfModels` and `getHfModelDetail` which exist but return `object` — replace those two lines too.

- [ ] **Step 3: Add typed domain methods to the `tauri` export object**

After the `settings` domain block, add:

```ts
  hf: {
    search: async (query: string, cursor?: string | null) =>
      unwrap(await raw.searchHfModels(query, cursor)),
    detail: async (repoId: string) =>
      unwrap(await raw.getHfModelDetail(repoId)),
    modelSizeInfo: async (repoId: string, filename: string) =>
      unwrap(await raw.getModelSizeInfo(repoId, filename)),
  },

  download: {
    start:  async (repoId: string, filename: string) =>
      unwrap(await raw.downloadModel(repoId, filename)),
    cancel: async (modelId: string) =>
      unwrap(await raw.cancelDownload(modelId)),
  },

  system: {
    info: async () => raw.getSystemInfo(),
  },
```

Also add `delete` to the `models` domain after `unload`:
```ts
    delete: async (path: string) => unwrap(await raw.deleteModel(path)),
```

- [ ] **Step 4: Verify typecheck**

Run: `cd frontend-react && npm run typecheck`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add frontend-react/src/lib/tauri/index.ts
git commit -m "feat(react): extend IPC façade with download, HF search, sysinfo typed commands"
```

---

## Task 2: `lib/modelUtils.ts` — pure helpers + tests (TDD)

**Files:**
- Create: `frontend-react/src/lib/__tests__/modelUtils.test.ts`
- Create: `frontend-react/src/lib/modelUtils.ts`

- [ ] **Step 1: Write failing tests**

Create `frontend-react/src/lib/__tests__/modelUtils.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  QUANT_RANK, quantQualityRank, extractQuant, cleanModelName,
  quantToQuality, quantToBadge, sizeGb, fmtNum, fmtDate,
  shortRepo, stripFrontmatter, compatLevel, pickFittedFile, globalFittedQuant,
} from '@/lib/modelUtils';
import type { SystemInfo, HfFile } from '@/lib/tauri';

const sys = (vram: number, ram: number): SystemInfo => ({
  os: 'windows', cpu: 'test', cores: 8,
  ram_total_mb: ram, ram_used_mb: 1024,
  gpu_name: 'Test GPU', vram_total_mb: vram, vram_used_mb: 0,
  supports_vulkan: true,
});

const file = (name: string, size: number): HfFile => ({ rfilename: name, size });

describe('extractQuant', () => {
  it('extracts Q4_K_M from filename', () => {
    expect(extractQuant('model.Q4_K_M.gguf')).toBe('Q4_K_M');
  });
  it('extracts F16', () => {
    expect(extractQuant('model.F16.gguf')).toBe('F16');
  });
  it('returns — for unknown', () => {
    expect(extractQuant('model.gguf')).toBe('—');
  });
});

describe('cleanModelName', () => {
  it('strips .gguf and quant suffix, title-cases result', () => {
    expect(cleanModelName('llama-3.1-8b.Q4_K_M.gguf')).toBe('Llama 3.1 8b');
  });
  it('handles underscore separators', () => {
    expect(cleanModelName('my_model_name.gguf')).toBe('My Model Name');
  });
  it('no double spaces', () => {
    expect(cleanModelName('a--b.gguf')).not.toMatch(/  /);
  });
});

describe('quantToQuality', () => {
  it('Q4_K_M → Balanced quality', () => {
    expect(quantToQuality('Q4_K_M')).toBe('Balanced quality');
  });
  it('Q8_0 → Best quality', () => {
    expect(quantToQuality('Q8_0')).toBe('Best quality');
  });
  it('F16 → Full precision', () => {
    expect(quantToQuality('F16')).toBe('Full precision');
  });
  it('unknown → Standard', () => {
    expect(quantToQuality('UNKNOWN')).toBe('Standard');
  });
  it('case insensitive', () => {
    expect(quantToQuality('q4_k_m')).toBe('Balanced quality');
  });
});

describe('quantToBadge', () => {
  it('F16 → full variant', () => {
    expect(quantToBadge('F16')).toEqual({ label: 'Full', variant: 'full' });
  });
  it('Q8_0 → high variant', () => {
    expect(quantToBadge('Q8_0')).toEqual({ label: 'High', variant: 'high' });
  });
  it('Q4_K_M → balanced variant', () => {
    expect(quantToBadge('Q4_K_M')).toEqual({ label: 'Balanced', variant: 'balanced' });
  });
  it('Q2_K → small variant', () => {
    expect(quantToBadge('Q2_K')).toEqual({ label: 'Small', variant: 'small' });
  });
  it('IQ1_M → tiny variant', () => {
    expect(quantToBadge('IQ1_M')).toEqual({ label: 'Tiny', variant: 'tiny' });
  });
  it('case insensitive', () => {
    expect(quantToBadge('f16').variant).toBe('full');
  });
});

describe('quantQualityRank', () => {
  it('uses QUANT_RANK map', () => {
    expect(QUANT_RANK['q4_k_m']).toBe(55);
    expect(QUANT_RANK['f16']).toBe(100);
  });
  it('Q4_K_M rank > Q4_0 rank', () => {
    expect(quantQualityRank('model.Q4_K_M.gguf')).toBeGreaterThan(quantQualityRank('model.Q4_0.gguf'));
  });
  it('Q8_0 rank > Q6_K rank', () => {
    expect(quantQualityRank('model.Q8_0.gguf')).toBeGreaterThan(quantQualityRank('model.Q6_K.gguf'));
  });
  it('F16 = 100', () => {
    expect(quantQualityRank('model.F16.gguf')).toBe(100);
  });
  it('unknown defaults to 35', () => {
    expect(quantQualityRank('model.UNKNOWN.gguf')).toBe(35);
  });
});

describe('sizeGb', () => {
  it('< 1 GB returns MB', () => {
    expect(sizeGb(512 * 1024 * 1024)).toMatch(/MB/);
  });
  it('>= 1 GB returns GB with 1 decimal', () => {
    expect(sizeGb(4.7 * 1024 * 1024 * 1024)).toMatch(/4\.7 GB/);
  });
});

describe('stripFrontmatter', () => {
  it('strips YAML frontmatter', () => {
    const md = '---\ntitle: test\n---\n\n# Hello';
    expect(stripFrontmatter(md)).toBe('# Hello');
  });
  it('no-op if no frontmatter', () => {
    expect(stripFrontmatter('# Hello')).toBe('# Hello');
  });
  it('preserves content after frontmatter', () => {
    const md = '---\nfoo: bar\n---\ncontent here';
    expect(stripFrontmatter(md)).toBe('content here');
  });
});

describe('compatLevel', () => {
  it('fits when file <= 70% of vram', () => {
    // 4GB VRAM, comfortable = 2.8GB, file = 2GB → fits
    expect(compatLevel(2 * 1024 * 1024 * 1024, sys(4096, 32768))).toBe('fits');
  });
  it('slow when file > 70% but <= 100% of vram', () => {
    // 4GB VRAM, comfortable = 2.8GB, file = 3.5GB → slow
    expect(compatLevel(3.5 * 1024 * 1024 * 1024, sys(4096, 32768))).toBe('slow');
  });
  it('no when file exceeds vram', () => {
    // 4GB VRAM, file = 6GB → no
    expect(compatLevel(6 * 1024 * 1024 * 1024, sys(4096, 32768))).toBe('no');
  });
  it('returns null when sys is null', () => {
    expect(compatLevel(1024, null)).toBeNull();
  });
});

describe('pickFittedFile', () => {
  it('returns null for empty array', () => {
    expect(pickFittedFile([], sys(8192, 32768))).toBeNull();
  });
  it('returns highest-rank file that fits comfortably', () => {
    const files = [
      file('model.Q4_K_M.gguf', 4 * 1024 * 1024 * 1024),
      file('model.Q8_0.gguf',   8 * 1024 * 1024 * 1024),
    ];
    // 16GB VRAM — both fit; Q8_0 has higher rank
    const result = pickFittedFile(files, sys(16384, 32768));
    expect(result?.rfilename).toBe('model.Q8_0.gguf');
  });
  it('falls back to smallest slow file when nothing fits comfortably', () => {
    const files = [
      file('model.Q4_K_M.gguf', 3 * 1024 * 1024 * 1024),
      file('model.Q8_0.gguf',   7 * 1024 * 1024 * 1024),
    ];
    // 4GB VRAM comfortable=2.8GB — Q4_K_M is slow, Q8_0 is no
    const result = pickFittedFile(files, sys(4096, 32768));
    expect(result?.rfilename).toBe('model.Q4_K_M.gguf');
  });
});

describe('globalFittedQuant', () => {
  it('8192 MB VRAM → Q4_K_M', () => {
    expect(globalFittedQuant(sys(8192, 32768))).toBe('Q4_K_M');
  });
  it('32768 MB VRAM → Q8_0', () => {
    expect(globalFittedQuant(sys(32768, 65536))).toBe('Q8_0');
  });
  it('null sys → Q4_K_M (8192 default)', () => {
    expect(globalFittedQuant(null)).toBe('Q4_K_M');
  });
});
```

- [ ] **Step 2: Run — verify all fail**

Run: `cd frontend-react && npm test -- src/lib/__tests__/modelUtils.test.ts`
Expected: FAIL — "Cannot find module '@/lib/modelUtils'"

- [ ] **Step 3: Implement `frontend-react/src/lib/modelUtils.ts`**

```ts
import type { HfFile, SystemInfo } from '@/lib/tauri';

// ── Quantization rank — higher = better quality ──────────────────────────────
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

export function extractQuant(filename: string): string {
  const lower = filename.toLowerCase();
  const noExt = lower.endsWith('.gguf') ? lower.slice(0, -5) : lower;
  const lastDot = noExt.lastIndexOf('.');
  if (lastDot === -1) return '—';
  const suffix = noExt.slice(lastDot + 1);
  if (
    suffix.startsWith('q') ||
    suffix.startsWith('iq') ||
    suffix.startsWith('f') ||
    suffix.startsWith('bf')
  ) {
    return suffix.toUpperCase();
  }
  return '—';
}

export function quantQualityRank(filename: string): number {
  const quant = extractQuant(filename).toLowerCase();
  return QUANT_RANK[quant] ?? 35;
}

export function cleanModelName(filename: string): string {
  const lower = filename.toLowerCase();
  const noExt = lower.endsWith('.gguf') ? lower.slice(0, -5) : lower;
  const lastDot = noExt.lastIndexOf('.');
  const cleaned =
    lastDot !== -1 &&
    (noExt[lastDot + 1] === 'q' ||
      noExt.slice(lastDot + 1).startsWith('iq') ||
      noExt.slice(lastDot + 1).startsWith('f') ||
      noExt.slice(lastDot + 1).startsWith('bf'))
      ? noExt.slice(0, lastDot)
      : noExt;
  return cleaned
    .split(/[-_]+/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

export function quantToQuality(quant: string): string {
  const q = quant.toLowerCase();
  if (q.includes('iq1')) return 'Ultra fast (lower quality)';
  if (q.includes('iq2') || q.includes('q2_k') || q.startsWith('q2')) return 'Fastest';
  if (q.includes('q3')) return 'Fast';
  if (q.includes('q4_k_m') || q.includes('q4_k')) return 'Balanced quality';
  if (q.includes('q4')) return 'Standard quality';
  if (q.includes('q5')) return 'High quality';
  if (q.includes('q6')) return 'Very high quality';
  if (q.includes('q8')) return 'Best quality';
  if (q.includes('f16') || q.includes('fp16') || q.includes('bf16')) return 'Full precision';
  if (q.includes('f32')) return 'Full precision (32-bit)';
  return 'Standard';
}

export type QuantVariant = 'full' | 'high' | 'balanced' | 'small' | 'tiny';

export function quantToBadge(quant: string): { label: string; variant: QuantVariant } {
  const q = quant.toLowerCase();
  if (q.includes('f16') || q.includes('fp16') || q.includes('bf16') || q.includes('f32'))
    return { label: 'Full', variant: 'full' };
  if (q.includes('q8') || q.includes('q6'))
    return { label: 'High', variant: 'high' };
  if (q.includes('q4_k') || q.includes('q5'))
    return { label: 'Balanced', variant: 'balanced' };
  if (q.includes('q4') || q.includes('q3') || q.includes('iq2') || q.includes('q2'))
    return { label: 'Small', variant: 'small' };
  if (q.includes('iq1') || q.includes('q1'))
    return { label: 'Tiny', variant: 'tiny' };
  return { label: 'Small', variant: 'small' };
}

export function sizeGb(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb < 1) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${gb.toFixed(1)} GB`;
}

export function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}

export function shortRepo(id: string): string {
  return id.split('/').pop() ?? id;
}

export function stripFrontmatter(md: string): string {
  if (!md.startsWith('---')) return md;
  const rest = md.slice(3);
  const closeIdx = rest.indexOf('\n---');
  if (closeIdx === -1) return md;
  return rest.slice(closeIdx + 4).trimStart();
}

// ── Hardware compatibility ────────────────────────────────────────────────────
export type Compat = 'fits' | 'slow' | 'no';

export function compatLevel(bytes: number, sys: SystemInfo | null): Compat | null {
  if (!sys) return null;
  const capacityMb = sys.vram_total_mb > 0
    ? sys.vram_total_mb
    : Math.max(0, sys.ram_total_mb - sys.ram_used_mb);
  const capacityBytes = capacityMb * 1024 * 1024;
  if (capacityBytes === 0) return 'no';
  const comfortable = (capacityBytes * 7) / 10;
  if (bytes <= comfortable) return 'fits';
  if (bytes <= capacityBytes) return 'slow';
  return 'no';
}

export function pickFittedFile(files: HfFile[], sys: SystemInfo | null): HfFile | null {
  if (files.length === 0) return null;
  const withSize = files.filter((f) => f.size && f.size > 0);
  if (withSize.length === 0) return files[0];

  const fits = withSize.filter((f) => compatLevel(f.size!, sys) === 'fits');
  if (fits.length > 0) {
    return fits.reduce((best, f) =>
      quantQualityRank(f.rfilename) > quantQualityRank(best.rfilename) ? f : best,
    );
  }

  const slow = withSize.filter((f) => compatLevel(f.size!, sys) === 'slow');
  if (slow.length > 0) {
    return slow.reduce((best, f) => (f.size! < best.size! ? f : best));
  }

  return withSize.reduce((best, f) => (f.size! < best.size! ? f : best));
}

export function globalFittedQuant(sys: SystemInfo | null): string {
  const mb = sys
    ? sys.vram_total_mb > 0
      ? sys.vram_total_mb
      : Math.max(0, sys.ram_total_mb - sys.ram_used_mb)
    : 8192;
  if (mb >= 32768) return 'Q8_0';
  if (mb >= 24576) return 'Q6_K';
  if (mb >= 12288) return 'Q5_K_M';
  if (mb >= 8192) return 'Q4_K_M';
  if (mb >= 4096) return 'Q3_K_M';
  return 'Q2_K';
}
```

- [ ] **Step 4: Run — verify all pass**

Run: `cd frontend-react && npm test -- src/lib/__tests__/modelUtils.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add frontend-react/src/lib/modelUtils.ts frontend-react/src/lib/__tests__/modelUtils.test.ts
git commit -m "feat(react): modelUtils — port Leptos pure helpers with QUANT_RANK map + full test coverage"
```

---

## Task 3: `stores/download.ts` + `stores/systemInfo.ts`

**Files:**
- Create: `frontend-react/src/stores/download.ts`
- Create: `frontend-react/src/stores/systemInfo.ts`

- [ ] **Step 1: Create `stores/download.ts`**

```ts
// stores/download.ts
import { create } from 'zustand';
import { listen } from '@tauri-apps/api/event';
import { tauri } from '@/lib/tauri';
import { useModel } from './model';
import type {
  DownloadProgressEvent,
  DownloadCompleteEvent,
  DownloadErrorEvent,
} from '@/lib/tauri/events';

interface ActiveDownload {
  repoId: string;
  filename: string;
  progress: number;   // 0.0 – 1.0
  key: string;        // "repoId::filename"
}

interface DownloadStore {
  active: ActiveDownload | null;
  done: boolean;
  error: string | null;

  start:  (repoId: string, filename: string) => Promise<void>;
  cancel: () => Promise<void>;
  reset:  () => void;
}

export const useDownload = create<DownloadStore>((set, get) => ({
  active: null,
  done:   false,
  error:  null,

  start: async (repoId, filename) => {
    if (get().active !== null) throw new Error('A download is already in progress');
    const key = `${repoId}::${filename}`;
    set({ active: { repoId, filename, progress: 0, key }, done: false, error: null });
    // Fire-and-forget — completion comes via module-level event listeners
    try {
      await tauri.download.start(repoId, filename);
    } catch (err) {
      set({ active: null, error: String(err) });
    }
  },

  cancel: async () => {
    const { active } = get();
    if (!active) return;
    set({ active: null, done: false, error: null });
    try {
      await tauri.download.cancel(active.key);
    } catch { /* ignore — already cleared */ }
  },

  reset: () => set({ active: null, done: false, error: null }),
}));

// ── Module-level listeners — always-on, outlive any component ────────────────
// CRITICAL: these MUST be outside create() so they fire even when the
// component that called start() has unmounted (e.g. navigated away).
void listen<DownloadProgressEvent>('feral://download-progress', (e) => {
  const { active } = useDownload.getState();
  const key = `${e.payload.repoId}::${e.payload.filename}`;
  if (active?.key !== key) return;
  useDownload.setState({ active: { ...active, progress: e.payload.progress } });
});

void listen<DownloadCompleteEvent>('feral://download-complete', () => {
  useDownload.setState({ active: null, done: true, error: null });
  void useModel.getState().refresh();
});

void listen<DownloadErrorEvent>('feral://download-error', (e) => {
  if (e.payload.cancelled) {
    useDownload.setState({ active: null, done: false, error: null });
  } else {
    useDownload.setState({ active: null, error: e.payload.error });
  }
});
```

- [ ] **Step 2: Create `stores/systemInfo.ts`**

```ts
// stores/systemInfo.ts
import { create } from 'zustand';
import { tauri, type SystemInfo } from '@/lib/tauri';

interface SystemInfoStore {
  info: SystemInfo | null;
  loading: boolean;
  fetch: () => Promise<void>;
}

export const useSystemInfo = create<SystemInfoStore>((set, get) => ({
  info:    null,
  loading: false,

  fetch: async () => {
    if (get().loading || get().info) return;   // fetch once only
    set({ loading: true });
    try {
      const info = await tauri.system.info();
      set({ info: info as SystemInfo, loading: false });
    } catch {
      set({ loading: false });   // degrade gracefully — system bar just stays hidden
    }
  },
}));
```

- [ ] **Step 3: Verify typecheck**

Run: `cd frontend-react && npm run typecheck`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add frontend-react/src/stores/download.ts frontend-react/src/stores/systemInfo.ts
git commit -m "feat(react): add download store (module-level listeners) + systemInfo store"
```

---

## Task 4: `SystemBar` + `ByokBanner`

**Files:**
- Create: `frontend-react/src/components/models/SystemBar.tsx`
- Create: `frontend-react/src/components/models/ByokBanner.tsx`

- [ ] **Step 1: Create `SystemBar.tsx`**

```tsx
// src/components/models/SystemBar.tsx
import { useSystemInfo } from '@/stores/systemInfo';

export function SystemBar() {
  const info = useSystemInfo((s) => s.info);
  if (!info) return null;

  const vram =
    info.vram_total_mb > 0
      ? `${Math.round(info.vram_total_mb / 1024)} GB VRAM`
      : 'Integrated GPU';
  const ram = `${Math.round(info.ram_total_mb / 1024)} GB RAM`;

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-bg-surface border-b border-border-subtle text-sm text-text-secondary shrink-0">
      <span className="font-medium">{info.gpu_name}</span>
      <span className="text-border-default">·</span>
      <span>{vram}</span>
      <span className="text-border-default">·</span>
      <span>{ram}</span>
      <span className="text-border-default">·</span>
      {info.supports_vulkan ? (
        <span className="text-success">Vulkan ✓</span>
      ) : (
        <span className="text-text-muted">Vulkan unavailable</span>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create `ByokBanner.tsx`**

```tsx
// src/components/models/ByokBanner.tsx
import { useNavigate } from 'react-router-dom';
import { Cloud, ChevronRight } from 'lucide-react';

export function ByokBanner() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate('/settings')}
      className="w-full flex items-center gap-2 px-4 py-2 bg-bg-surface border-b border-border-subtle text-text-muted text-sm hover:bg-bg-hover transition-colors shrink-0"
    >
      <Cloud size={14} className="shrink-0" />
      <span>Want to use cloud AI? Configure OpenAI, Anthropic and others in</span>
      <span className="text-brand font-medium">Settings → BYOK</span>
      <ChevronRight size={12} className="ml-auto shrink-0" />
    </button>
  );
}
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add frontend-react/src/components/models/SystemBar.tsx frontend-react/src/components/models/ByokBanner.tsx
git commit -m "feat(react): SystemBar (GPU/RAM/Vulkan) + ByokBanner (link to Settings)"
```

---

## Task 5: `LocalModelCard` + component test (TDD)

**Files:**
- Create: `frontend-react/src/components/models/__tests__/LocalModelCard.test.tsx`
- Create: `frontend-react/src/components/models/LocalModelCard.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// src/components/models/__tests__/LocalModelCard.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LocalModelCard } from '@/components/models/LocalModelCard';
import { useModel } from '@/stores/model';
import type { ModelInfo } from '@/lib/tauri';

const model: ModelInfo = {
  id: 'test', name: 'llama3.Q4_K_M.gguf', path: '/models/llama3.Q4_K_M.gguf',
  size_bytes: 4_700_000_000, quant: 'Q4_K_M', ctx_len: 4096, loaded: false,
};

vi.mock('@/stores/model', () => ({
  useModel: vi.fn(),
}));

const mockUseModel = vi.mocked(useModel);

describe('LocalModelCard', () => {
  it('idle: shows Load + Delete, no progress bar', () => {
    mockUseModel.mockImplementation((sel: any) =>
      sel({ loaded: null, isLoading: false, loadProgress: null, load: vi.fn(), unload: vi.fn() })
    );
    const onDelete = vi.fn();
    render(<LocalModelCard model={model} onDelete={onDelete} />);
    expect(screen.getByRole('button', { name: /load/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /delete/i })).toBeEnabled();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('loading: shows progress bar, hides Load + Delete', () => {
    mockUseModel.mockImplementation((sel: any) =>
      sel({
        loaded: null, isLoading: true,
        loadProgress: { percentage: 75, statusText: 'Warming KV cache...' },
        load: vi.fn(), unload: vi.fn(),
      })
    );
    render(<LocalModelCard model={model} onDelete={vi.fn()} />);
    expect(screen.getByText(/75/)).toBeInTheDocument();
    expect(screen.getByText(/Warming KV cache/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^load$/i })).not.toBeInTheDocument();
  });

  it('loaded: shows Active badge, Unload + Delete', () => {
    mockUseModel.mockImplementation((sel: any) =>
      sel({
        loaded: { path: model.path, name: 'test', ctx_len: 4096 },
        isLoading: false, loadProgress: null,
        load: vi.fn(), unload: vi.fn(),
      })
    );
    render(<LocalModelCard model={model} onDelete={vi.fn()} />);
    expect(screen.getByText(/active/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /unload/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^load$/i })).not.toBeInTheDocument();
  });

  it('deleting: delete button shows spinner text, Load disabled', async () => {
    mockUseModel.mockImplementation((sel: any) =>
      sel({ loaded: null, isLoading: false, loadProgress: null, load: vi.fn(), unload: vi.fn() })
    );
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(<LocalModelCard model={model} onDelete={onDelete} />);
    await userEvent.click(screen.getByRole('button', { name: /delete/i }));
    // During deletion the Load button should be disabled
    expect(screen.getByRole('button', { name: /load/i })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run — verify fails**

Run: `npm test -- src/components/models/__tests__/LocalModelCard.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `LocalModelCard.tsx`**

```tsx
// src/components/models/LocalModelCard.tsx
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { useModel } from '@/stores/model';
import { cleanModelName, quantToQuality, quantToBadge, sizeGb, type QuantVariant } from '@/lib/modelUtils';
import type { ModelInfo } from '@/lib/tauri';

const badgeClass: Record<QuantVariant, string> = {
  full:     'text-text-secondary bg-bg-elevated',
  high:     'text-success',
  balanced: 'text-brand',
  small:    'text-text-muted',
  tiny:     'text-text-muted',
};

interface Props {
  model: ModelInfo;
  onDelete: (path: string) => Promise<void>;
}

export function LocalModelCard({ model, onDelete }: Props) {
  const loaded      = useModel((s) => s.loaded);
  const isLoading   = useModel((s) => s.isLoading);
  const loadProgress = useModel((s) => s.loadProgress);
  const load        = useModel((s) => s.load);
  const unload      = useModel((s) => s.unload);
  const [isDeleting, setIsDeleting] = useState(false);

  const path       = model.path as unknown as string;
  const isActive   = loaded?.path === path;
  const isLoadingThis = isLoading && loadProgress !== null && !isActive;

  const displayName = cleanModelName(model.name);
  const sizeStr     = sizeGb(model.size_bytes);
  const quality     = quantToQuality(model.quant ?? '');
  const { label: badgeLabel, variant } = quantToBadge(model.quant ?? '');

  const handleLoad = () => { void load(path); };
  const handleUnload = () => { void unload(); };
  const handleDelete = async () => {
    setIsDeleting(true);
    try { await onDelete(path); } finally { setIsDeleting(false); }
  };

  return (
    <div className={cn(
      'rounded-lg border border-border-default bg-bg-surface p-4 flex flex-col gap-3',
      isActive && 'border-brand',
    )}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium text-text-primary truncate">{displayName}</span>
        {isActive && (
          <span className="text-xs font-medium text-brand shrink-0">● Active</span>
        )}
      </div>

      <div className="flex items-center gap-2 text-xs text-text-muted">
        <span>{sizeStr}</span>
        <span>·</span>
        <span>{quality}</span>
        <span className={cn('ml-auto text-[10px] px-1.5 py-0.5 rounded', badgeClass[variant])}>
          {badgeLabel}
        </span>
      </div>

      {isLoadingThis && loadProgress ? (
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-text-muted">
            <span>{loadProgress.statusText}</span>
            <span>{loadProgress.percentage.toFixed(0)}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-bg-elevated overflow-hidden" role="progressbar">
            <div
              className="h-full bg-brand transition-all duration-300"
              style={{ width: `${loadProgress.percentage}%` }}
            />
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          {isActive ? (
            <>
              <button
                type="button"
                onClick={handleUnload}
                className="flex-1 text-xs py-1.5 rounded border border-border-default text-text-secondary hover:bg-bg-hover transition-colors"
              >
                Unload
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={isDeleting}
                className="flex-1 text-xs py-1.5 rounded border border-error text-error hover:bg-bg-hover transition-colors disabled:opacity-60"
              >
                {isDeleting ? '⠼ Deleting' : 'Delete'}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={handleLoad}
                disabled={isDeleting || isLoading}
                aria-label="Load"
                className="flex-1 text-xs py-1.5 rounded bg-bg-elevated text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-60"
              >
                Load
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={isDeleting}
                aria-label="Delete"
                className="flex-1 text-xs py-1.5 rounded border border-border-default text-text-muted hover:bg-bg-hover transition-colors disabled:opacity-60"
              >
                {isDeleting ? '⠼ Deleting' : 'Delete'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run — verify passes**

Run: `npm test -- src/components/models/__tests__/LocalModelCard.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend-react/src/components/models/LocalModelCard.tsx frontend-react/src/components/models/__tests__/LocalModelCard.test.tsx
git commit -m "feat(react): LocalModelCard — 4 states (idle/loading/active/deleting) with tests"
```

---

## Task 6: `LocalModelsTab`

**Files:**
- Create: `frontend-react/src/components/models/LocalModelsTab.tsx`

- [ ] **Step 1: Implement `LocalModelsTab.tsx`**

```tsx
// src/components/models/LocalModelsTab.tsx
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { LocalModelCard } from './LocalModelCard';
import { tauri, type ModelInfo } from '@/lib/tauri';
import { useModel } from '@/stores/model';
import { useDownload } from '@/stores/download';

interface Props { onBrowse: () => void }

export function LocalModelsTab({ onBrowse }: Props) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const loaded   = useModel((s) => s.loaded);
  const doneFlag = useDownload((s) => s.done);

  const refresh = async () => {
    try {
      const list = await tauri.models.list();
      setModels(list);
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => { void refresh(); }, []);

  // Re-fetch when a download completes (download.ts fires useModel.refresh too)
  useEffect(() => { if (doneFlag) void refresh(); }, [doneFlag]);

  const handleDelete = async (path: string) => {
    // Unload first if currently loaded — prevents Windows file-lock
    if (loaded?.path === path) {
      await tauri.models.unload();
    }
    await tauri.models.delete(path);
    await refresh();
  };

  if (error) {
    return (
      <div className="p-4 text-error text-sm">{error}</div>
    );
  }

  if (models.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-text-muted px-6 gap-4">
        <p className="text-center">
          No models installed yet.<br />
          Switch to Browse HuggingFace to download your first model.
        </p>
        <Button variant="outline" onClick={onBrowse}>Browse HuggingFace →</Button>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {models.map((m) => (
          <LocalModelCard
            key={m.path as unknown as string}
            model={m}
            onDelete={handleDelete}
          />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add frontend-react/src/components/models/LocalModelsTab.tsx
git commit -m "feat(react): LocalModelsTab — responsive grid, empty state, delete-unloads-first"
```

---

## Task 7: `HfDetailPanel`

**Files:**
- Create: `frontend-react/src/components/models/HfDetailPanel.tsx`

- [ ] **Step 1: Install shadcn Collapsible (for README)**

Run: `cd frontend-react && npx shadcn@latest add collapsible --yes`
Expected: `src/components/ui/collapsible.tsx` created.

- [ ] **Step 2: Implement `HfDetailPanel.tsx`**

```tsx
// src/components/models/HfDetailPanel.tsx
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { Markdown } from '@/lib/markdown';
import { StreamingIndicator } from '@/components/chat/StreamingIndicator';
import { useModel } from '@/stores/model';
import { useDownload } from '@/stores/download';
import { useSystemInfo } from '@/stores/systemInfo';
import { tauri, type HfModelDetail, type HfFile } from '@/lib/tauri';
import {
  quantToBadge, sizeGb, pickFittedFile, stripFrontmatter, type QuantVariant,
} from '@/lib/modelUtils';

const badgeClass: Record<QuantVariant, string> = {
  full:     'text-text-secondary bg-bg-elevated',
  high:     'text-success',
  balanced: 'text-brand',
  small:    'text-text-muted',
  tiny:     'text-text-disabled',
};

interface Props {
  repoId: string;
  detail: HfModelDetail;
  loading: boolean;
}

export function HfDetailPanel({ repoId, detail, loading }: Props) {
  const navigate    = useNavigate();
  const sysInfo     = useSystemInfo((s) => s.info);
  const localModels = useModel((s) => s.loaded);
  const isLoading   = useModel((s) => s.isLoading);
  const loadProgress = useModel((s) => s.loadProgress);
  const modelLoad   = useModel((s) => s.load);
  const download    = useDownload();

  const recommended = pickFittedFile(detail.ggufFiles, sysInfo);
  const [selected, setSelected] = useState<HfFile | null>(recommended ?? detail.ggufFiles[0] ?? null);
  const [fileSizes, setFileSizes] = useState<Record<string, number>>(() => {
    const m: Record<string, number> = {};
    detail.ggufFiles.forEach((f) => { if (f.size) m[f.rfilename] = f.size; });
    return m;
  });

  // Fetch missing file sizes via HEAD request
  useEffect(() => {
    detail.ggufFiles
      .filter((f) => !f.size)
      .forEach((f) => {
        void tauri.hf.modelSizeInfo(repoId, f.rfilename).then((bytes) => {
          if (bytes > 0) setFileSizes((prev) => ({ ...prev, [f.rfilename]: bytes }));
        }).catch(() => {});
      });
  }, [repoId, detail.ggufFiles]);

  if (loading) {
    return <div className="flex justify-center py-6"><StreamingIndicator /></div>;
  }

  // Determine local installed path for the selected file
  const installedModel = selected
    ? null  // We compare by filename since we don't have the full local list here
    : null;
  // We need the full local models list — read from the tauri models directly
  // This is resolved in LocalModelsTab by passing localModels, but HfDetailPanel
  // accesses it via a one-time fetch on selection change
  const [localModelPath, setLocalModelPath] = useState<string | null>(null);
  useEffect(() => {
    if (!selected) { setLocalModelPath(null); return; }
    void tauri.models.list().then((list) => {
      const match = list.find((m) => m.name === selected.rfilename);
      setLocalModelPath(match ? (match.path as unknown as string) : null);
    }).catch(() => {});
  }, [selected]);

  const isDownloading = download.active?.repoId === repoId;
  const isThisDone    = download.done && localModelPath !== null;

  const handleInstall = async () => {
    if (!selected) return;
    await useDownload.getState().start(repoId, selected.rfilename);
  };

  const handleLoad = async () => {
    if (!localModelPath) return;
    await modelLoad(localModelPath);
    navigate('/chat');
  };

  return (
    <div className="space-y-4 pt-4">
      {/* File list */}
      <div className="space-y-1">
        <p className="text-xs font-medium text-text-muted uppercase tracking-wider mb-2">Download Options</p>
        {detail.ggufFiles.map((f) => {
          const isSelected = selected?.rfilename === f.rfilename;
          const isRecommended = recommended?.rfilename === f.rfilename;
          const size = fileSizes[f.rfilename];
          const { label, variant } = quantToBadge(f.rfilename);

          return (
            <button
              key={f.rfilename}
              type="button"
              onClick={() => setSelected(f)}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded text-sm text-left transition-colors
                ${isSelected ? 'bg-bg-active border border-brand' : 'bg-bg-elevated border border-transparent hover:bg-bg-hover'}`}
            >
              <span className={`w-3 h-3 rounded-full border-2 shrink-0 ${isSelected ? 'border-brand bg-brand' : 'border-border-default'}`} />
              <span className="flex-1 text-text-primary font-mono text-xs truncate">{f.rfilename}</span>
              <span className="text-text-muted text-xs shrink-0">
                {size ? sizeGb(size) : '…'}
              </span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${badgeClass[variant]}`}>
                {label}
              </span>
              {isRecommended && (
                <span className="flex items-center gap-1 text-[10px] text-brand shrink-0">
                  <Star size={10} fill="currentColor" /> Recommended
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Action area */}
      <div>
        {isDownloading ? (
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-text-muted">
              <span>Downloading {download.active?.filename}</span>
              <span>{((download.active?.progress ?? 0) * 100).toFixed(0)}%</span>
            </div>
            <div className="h-2 rounded-full bg-bg-elevated overflow-hidden">
              <div
                className="h-full bg-brand transition-all duration-300"
                style={{ width: `${(download.active?.progress ?? 0) * 100}%` }}
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void useDownload.getState().cancel()}
              className="w-full"
            >
              Cancel
            </Button>
          </div>
        ) : isThisDone ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-success text-sm">
              <span>✓</span>
              <span>Model installed successfully</span>
            </div>
            <Button onClick={() => void handleLoad()} className="w-full" disabled={isLoading}>
              {isLoading && loadProgress ? `Loading ${loadProgress.percentage.toFixed(0)}%` : 'Load model'}
            </Button>
          </div>
        ) : localModelPath ? (
          <Button onClick={() => void handleLoad()} className="w-full" disabled={isLoading}>
            {isLoading && loadProgress ? `Loading ${loadProgress.percentage.toFixed(0)}%` : 'Load model'}
          </Button>
        ) : (
          <Button
            onClick={() => void handleInstall()}
            disabled={!selected || download.active !== null}
            className="w-full"
          >
            Install Model Locally
          </Button>
        )}
      </div>

      {/* README */}
      {detail.readme && (
        <Collapsible>
          <CollapsibleTrigger className="flex items-center gap-2 text-sm text-text-muted hover:text-text-secondary w-full text-left">
            <span>README</span>
            <span className="text-xs">▸</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-3 text-sm border-t border-border-subtle pt-3">
              <Markdown>{stripFrontmatter(detail.readme)}</Markdown>
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add frontend-react/src/components/models/HfDetailPanel.tsx frontend-react/src/components/ui/collapsible.tsx
git commit -m "feat(react): HfDetailPanel — file selection, download progress, load+navigate, README collapsible"
```

---

## Task 8: `HfModelCard` + `BrowseTab`

**Files:**
- Create: `frontend-react/src/components/models/HfModelCard.tsx`
- Create: `frontend-react/src/components/models/BrowseTab.tsx`

- [ ] **Step 1: Implement `HfModelCard.tsx`**

```tsx
// src/components/models/HfModelCard.tsx
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import { HfDetailPanel } from './HfDetailPanel';
import { StreamingIndicator } from '@/components/chat/StreamingIndicator';
import { fmtNum, fmtDate } from '@/lib/modelUtils';
import type { HfModelSummary, HfModelDetail } from '@/lib/tauri';

interface Props {
  model: HfModelSummary;
  expanded: boolean;
  detail: HfModelDetail | null;
  detailLoading: boolean;
  onExpand: (repoId: string) => void;
}

export function HfModelCard({ model, expanded, detail, detailLoading, onExpand }: Props) {
  const tags = model.tags.slice(0, 3).join(' · ');

  return (
    <div className="border border-border-default rounded-lg overflow-hidden bg-bg-surface">
      {/* Header row — always visible */}
      <button
        type="button"
        onClick={() => onExpand(model.id)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-bg-hover transition-colors text-left"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text-primary truncate">{model.id}</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-text-muted mt-0.5 flex-wrap">
            <span>⬇ {fmtNum(model.downloads)}</span>
            <span>♥ {model.likes}</span>
            <span>{fmtDate(model.lastModified)}</span>
            {tags && <><span>·</span><span className="truncate">{tags}</span></>}
          </div>
        </div>
        <motion.span
          animate={{ rotate: expanded ? 90 : 0 }}
          transition={{ duration: 0.18 }}
          className="text-text-muted shrink-0"
        >
          <ChevronRight size={16} />
        </motion.span>
      </button>

      {/* Expandable detail */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 border-t border-border-subtle">
              {detailLoading || !detail ? (
                <div className="flex justify-center py-4">
                  <StreamingIndicator />
                </div>
              ) : (
                <HfDetailPanel repoId={model.id} detail={detail} loading={false} />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
```

- [ ] **Step 2: Implement `BrowseTab.tsx`**

```tsx
// src/components/models/BrowseTab.tsx
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { HfModelCard } from './HfModelCard';
import { tauri, type HfModelSummary, type HfModelDetail } from '@/lib/tauri';

export function BrowseTab() {
  const [query, setQuery]               = useState('');
  const [results, setResults]           = useState<HfModelSummary[]>([]);
  const [nextCursor, setNextCursor]     = useState<string | null>(null);
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [detail, setDetail]             = useState<HfModelDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const popularLoaded = useRef(false);

  const doSearch = async (q: string, cursor?: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const page = await tauri.hf.search(q, cursor ?? null);
      if (cursor) {
        setResults((prev) => [...prev, ...page.models]);
      } else {
        setResults(page.models);
        setSelectedRepoId(null);
        setDetail(null);
      }
      setNextCursor(page.nextCursor);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  // Load trending on first mount — once only
  useEffect(() => {
    if (popularLoaded.current) return;
    popularLoaded.current = true;
    void doSearch('');
  }, []);

  const handleSearch = () => { void doSearch(query); };
  const handleLoadMore = () => { if (nextCursor) void doSearch(query, nextCursor); };
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') handleSearch();
  };

  const handleExpand = async (repoId: string) => {
    if (selectedRepoId === repoId) {
      setSelectedRepoId(null);
      return;
    }
    setSelectedRepoId(repoId);
    setDetail(null);
    setDetailLoading(true);
    try {
      const d = await tauri.hf.detail(repoId);
      setDetail(d);
    } catch (e) {
      setError(String(e));
    } finally {
      setDetailLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex gap-2 px-4 py-3 border-b border-border-subtle shrink-0">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search models on HuggingFace..."
            className="pl-8"
          />
        </div>
        <Button onClick={handleSearch} disabled={loading} variant="outline">
          Search
        </Button>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2">
        {error && (
          <div className="text-error text-sm p-3 rounded bg-bg-surface border border-error">
            {error}
          </div>
        )}

        {loading && results.length === 0 && (
          <div className="flex justify-center py-8 text-text-muted text-sm">Searching...</div>
        )}

        {results.map((m) => (
          <HfModelCard
            key={m.id}
            model={m}
            expanded={selectedRepoId === m.id}
            detail={selectedRepoId === m.id ? detail : null}
            detailLoading={selectedRepoId === m.id && detailLoading}
            onExpand={handleExpand}
          />
        ))}

        {nextCursor && (
          <div className="flex justify-center pt-2 pb-4">
            <Button
              variant="outline"
              onClick={handleLoadMore}
              disabled={loading}
            >
              {loading ? 'Loading...' : 'Load more'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add frontend-react/src/components/models/HfModelCard.tsx frontend-react/src/components/models/BrowseTab.tsx
git commit -m "feat(react): HfModelCard accordion + BrowseTab (search, trending, pagination, expand)"
```

---

## Task 9: `ModelsPage` + wire router + unlock sidebar

**Files:**
- Create: `frontend-react/src/pages/ModelsPage.tsx`
- Modify: `frontend-react/src/router.tsx`
- Modify: `frontend-react/src/components/layout/Sidebar.tsx`

- [ ] **Step 1: Create `ModelsPage.tsx`**

```tsx
// src/pages/ModelsPage.tsx
import { useEffect, useState } from 'react';
import { useSystemInfo } from '@/stores/systemInfo';
import { useModel } from '@/stores/model';
import { SystemBar } from '@/components/models/SystemBar';
import { ByokBanner } from '@/components/models/ByokBanner';
import { LocalModelsTab } from '@/components/models/LocalModelsTab';
import { BrowseTab } from '@/components/models/BrowseTab';
import { cn } from '@/lib/utils';

type Tab = 'local' | 'browse';

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-4 py-2 text-sm font-medium border-b-2 transition-colors',
        active
          ? 'border-brand text-brand'
          : 'border-transparent text-text-muted hover:text-text-secondary',
      )}
    >
      {children}
    </button>
  );
}

export function ModelsPage() {
  const [tab, setTab] = useState<Tab>('local');

  useEffect(() => {
    void useSystemInfo.getState().fetch();
    void useModel.getState().refresh();
  }, []);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <SystemBar />
      <ByokBanner />
      <div className="flex px-4 pt-2 border-b border-border-subtle shrink-0">
        <TabButton active={tab === 'local'}  onClick={() => setTab('local')}>Local Models</TabButton>
        <TabButton active={tab === 'browse'} onClick={() => setTab('browse')}>Browse HuggingFace</TabButton>
      </div>
      <div className="flex-1 overflow-hidden">
        {tab === 'local'  ? <LocalModelsTab onBrowse={() => setTab('browse')} /> : null}
        {tab === 'browse' ? <BrowseTab /> : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update `router.tsx`**

In `frontend-react/src/router.tsx`:
1. Add import: `import { ModelsPage } from '@/pages/ModelsPage';`
2. Replace the models route:
   - Old: `{ path: 'models', element: <StubPage title="Models" message="Coming in spec 2" /> }`
   - New: `{ path: 'models', element: <ModelsPage /> }`

- [ ] **Step 3: Unlock Models in Sidebar**

In `frontend-react/src/components/layout/Sidebar.tsx`, find the Models entry (line ~30):
```ts
{ icon: Box, label: 'Models', shortcut: null, action: 'models', disabled: true, route: '/models' },
```
Change `disabled: true` to `disabled: false`.

- [ ] **Step 4: Verify full typecheck + all tests pass**

Run: `cd frontend-react && npm run typecheck && npm run test:ci`
Expected: 0 TS errors; all tests pass (prior 16 + new modelUtils ~25 + LocalModelCard 4 = ~45+ passing).

- [ ] **Step 5: Commit**

```bash
git add frontend-react/src/pages/ModelsPage.tsx frontend-react/src/router.tsx frontend-react/src/components/layout/Sidebar.tsx
git commit -m "feat(react): wire ModelsPage into router, unlock Models sidebar item"
```

---

## Task 10: Manual verification (spec §7.3 DoD checklist)

**Files:** none (verification only)

- [ ] **Step 1: Run the app**

Run: `cargo tauri dev --config src-tauri/tauri.react.conf.json`
Expected: window opens, sidebar "Models" is now clickable (no lock icon).

- [ ] **Step 2: Hardcoded color check**

Run: `grep -rn "#[0-9a-fA-F]" frontend-react/src/components/models/`
Expected: zero hits. If any appear, replace with the appropriate `text-*` / `bg-*` Tailwind class using a CSS var.

- [ ] **Step 3: Run through the manual DoD checklist from spec §7.3**

Work through every item in the checklist. Mark each ✓ or note failures for fixing.

Key items to focus on:
- [ ] Sidebar Models item clickable, navigates to `/models`
- [ ] SystemBar appears (requires a moment), shows GPU/RAM/Vulkan
- [ ] ByokBanner visible on both tabs, click goes to `/settings`
- [ ] Local tab: empty state if no models; cards show correct name/size/quant if models exist
- [ ] Delete loaded model: unloads first (check no Windows file-lock error)
- [ ] Browse tab: trending models load automatically on first open
- [ ] Browse: re-opening tab after switching away does NOT re-fetch
- [ ] Browse: click card → expands; previous card collapses
- [ ] Browse: download → progress updates → success → "Load model" appears
- [ ] Browse: "Load model" navigates to `/chat`
- [ ] Local: "Load" stays on Models page
- [ ] README collapsible, frontmatter stripped

- [ ] **Step 4: Commit verification note**

```bash
git commit --allow-empty -m "test(spec2): manual verification complete — Models page DoD checklist passed"
```

---

## Self-Review

**Spec coverage:**
- §1.1 file structure → Task 9 wires all files; Tasks 3-8 create them ✓
- §1.2 sidebar unlock → Task 9 Step 3 ✓
- §2.1 download store with module-level listeners → Task 3 Step 1 (with verbatim critical comment) ✓
- §2.2 systemInfo store → Task 3 Step 2 ✓
- §3 modelUtils with QUANT_RANK map → Task 2 ✓
- §4 ModelsPage with tab state → Task 9 Step 1 ✓
- §4.2 SystemBar → Task 4 Step 1 ✓
- §4.3 ByokBanner → Task 4 Step 2 ✓
- §5.1 LocalModelsTab + responsive grid + empty state → Task 6 ✓
- §5.2 LocalModelCard 4 states + delete-unloads-first → Task 5 ✓
- §6.1 BrowseTab local state → Task 8 Step 2 ✓
- §6.2 search toolbar → Task 8 Step 2 ✓
- §6.3 HfModelCard accordion + one-at-a-time → Task 8 Step 1 ✓
- §6.4 HfDetailPanel: file list, recommended auto-select, lazy sizes, action states, README collapsible → Task 7 ✓
- §6.5 pagination Load more → Task 8 Step 2 ✓
- §7.1 modelUtils unit tests → Task 2 ✓
- §7.2 LocalModelCard component tests → Task 5 ✓
- §7.3 manual DoD checklist + grep for hardcoded hex → Task 10 ✓

**Placeholder scan:** No "TBD", "TODO", "implement later", "fill in details" found.

**Type consistency:**
- `HfModelSummary.lastModified` (camelCase, per serde `rename_all = "camelCase"` in Rust) — used consistently in `HfModelCard` (`model.lastModified`) and types added in Task 1 ✓
- `HfModelDetail.ggufFiles` (camelCase) — used in `HfDetailPanel` (`detail.ggufFiles`) ✓
- `HfSearchPage.nextCursor` (camelCase) — used in `BrowseTab` (`page.nextCursor`) ✓
- `ModelInfo.path` typed as `PathBuf` in Rust → serializes as string → typed as `unknown as string` cast matches Task 5 and Task 6 usage ✓
- `useDownload.getState().cancel()` called in `HfDetailPanel` cancel button ✓
- `tauri.hf.search` / `tauri.hf.detail` / `tauri.hf.modelSizeInfo` / `tauri.download.start` / `tauri.download.cancel` / `tauri.models.delete` all defined in Task 1, consumed in Tasks 6-8 ✓
