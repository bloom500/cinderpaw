# Cloud Providers (Kimi, GLM, MiniMax) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the three coding-plan provider URLs and wire model dropdowns + key-prefix hints into the existing BYOK UI, following the codebase's existing patterns exactly.

**Architecture:** All plumbing (SSE streaming, Tauri commands, model store, chat routing) already exists and works. The only gaps are (a) wrong base URLs in `byok.rs`, (b) the model field in `ByokTab` is a free-text input instead of a `<select>` for providers that have a fixed model list, and (c) no key-prefix feedback for Kimi / MiniMax keys. No new files, no new abstractions.

**Tech Stack:** Rust (byok.rs), React + TypeScript + Tailwind (ByokTab.tsx), vitest (ByokTab.test.tsx)

---

## File Map

| File | Change |
|---|---|
| `src-tauri/src/byok.rs` | Fix 3 `default_base_url` arms |
| `frontend-react/src/components/settings/ByokTab.tsx` | Add `availableModels` + `keyPrefix` fields to `PROVIDER_DEFS`; render `<select>` when `availableModels` present; show key-prefix hint |
| `frontend-react/src/components/settings/__tests__/ByokTab.test.tsx` | Update row count assertion; add model-select + key-prefix tests |

---

## Task 1: Fix backend provider URLs

**Files:**
- Modify: `src-tauri/src/byok.rs:31-33`

The three wrong URLs in `default_base_url()`:

| Provider | Current (wrong) | Correct |
|---|---|---|
| Kimi | `https://api.moonshot.cn/v1` | `https://api.kimi.com/coding/v1` |
| GLM | `https://open.bigmodel.cn/api/paas/v4` | `https://api.z.ai/api/coding/paas/v4` |
| MiniMax | `https://api.minimax.chat/v1` | `https://api.minimax.io/v1` |

- [ ] **Step 1: Fix the three URL arms**

In `src-tauri/src/byok.rs`, replace the three wrong arms in `default_base_url()`:

```rust
Provider::Kimi    => "https://api.kimi.com/coding/v1",
Provider::Glm     => "https://api.z.ai/api/coding/paas/v4",
Provider::Minimax => "https://api.minimax.io/v1",
```

- [ ] **Step 2: Verify Rust compiles**

```bash
cargo check -p feral
```

Expected: `Finished` with only the pre-existing dead-code warnings (4 warnings, 0 errors).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/byok.rs
git commit -m "fix(byok): correct base URLs for Kimi, GLM, MiniMax providers"
```

---

## Task 2: Extend PROVIDER_DEFS with availableModels + keyPrefix

**Files:**
- Modify: `frontend-react/src/components/settings/ByokTab.tsx:8-20` (the `PROVIDER_DEFS` const)

The existing `PROVIDER_DEFS` uses `{ id, name, hasBaseUrl, baseUrlHint }`. We add two optional fields:
- `availableModels?: readonly string[]` — when present, the model field renders as a `<select>` instead of a free-text input
- `keyPrefix?: string` — when present and the typed key starts with this prefix, show a "✓ {name} key detected" hint

- [ ] **Step 1: Update PROVIDER_DEFS**

Replace the entire `PROVIDER_DEFS` const in `ByokTab.tsx`:

```typescript
const PROVIDER_DEFS = [
  { id: 'openai',     name: 'OpenAI',         hasBaseUrl: true,  baseUrlHint: 'https://api.openai.com/v1',      availableModels: undefined,                                                                             keyPrefix: undefined  },
  { id: 'anthropic',  name: 'Anthropic',       hasBaseUrl: false, baseUrlHint: '',                               availableModels: undefined,                                                                             keyPrefix: undefined  },
  { id: 'google',     name: 'Google Gemini',   hasBaseUrl: false, baseUrlHint: '',                               availableModels: undefined,                                                                             keyPrefix: undefined  },
  { id: 'kimi',       name: 'Kimi',            hasBaseUrl: false, baseUrlHint: '',                               availableModels: ['kimi-for-coding'] as const,                                                         keyPrefix: 'sk-kimi-' },
  { id: 'glm',        name: 'GLM (Z.ai)',      hasBaseUrl: false, baseUrlHint: '',                               availableModels: ['glm-5.1', 'glm-5', 'glm-5-turbo', 'glm-4.7', 'glm-4.5-air'] as const,             keyPrefix: undefined  },
  { id: 'minimax',    name: 'MiniMax',         hasBaseUrl: false, baseUrlHint: '',                               availableModels: ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed'] as const, keyPrefix: 'sk-cp-'  },
  { id: 'deepseek',   name: 'DeepSeek',        hasBaseUrl: false, baseUrlHint: '',                               availableModels: undefined,                                                                             keyPrefix: undefined  },
  { id: 'groq',       name: 'Groq',            hasBaseUrl: false, baseUrlHint: '',                               availableModels: undefined,                                                                             keyPrefix: undefined  },
  { id: 'mistral',    name: 'Mistral',         hasBaseUrl: false, baseUrlHint: '',                               availableModels: undefined,                                                                             keyPrefix: undefined  },
  { id: 'openrouter', name: 'OpenRouter',      hasBaseUrl: true,  baseUrlHint: 'https://openrouter.ai/api/v1',  availableModels: undefined,                                                                             keyPrefix: undefined  },
  { id: 'custom',     name: 'Custom Endpoint', hasBaseUrl: true,  baseUrlHint: 'https://your-endpoint/v1',       availableModels: undefined,                                                                             keyPrefix: undefined  },
] as const;
```

Note: Kimi / GLM / MiniMax now have `hasBaseUrl: false` — their URLs are hardcoded in `byok.rs`, users don't need to override them.

- [ ] **Step 2: Check TypeScript compiles**

```bash
cd frontend-react && npx tsc --noEmit
```

Expected: no output (zero errors).

---

## Task 3: Update ProviderRow to use <select> and key-prefix hint

**Files:**
- Modify: `frontend-react/src/components/settings/ByokTab.tsx:24-170` (the `ProviderRow` function)

Two changes inside `ProviderRow`:
1. Initialize `defaultModel` from `def.availableModels[0]` when no saved model and a list exists
2. Render `<select>` instead of `<input type="text">` for the model field when `def.availableModels` is present
3. Show `"✓ {name} key detected"` hint below the API key input when `def.keyPrefix` is set and the typed key starts with that prefix

- [ ] **Step 1: Update the defaultModel initial state**

Change the `useState` for `defaultModel` inside `ProviderRow`:

```typescript
const [defaultModel, setDefModel] = useState(
  state?.default_model ??
  (def.availableModels ? def.availableModels[0] : ''),
);
```

- [ ] **Step 2: Replace the model field rendering**

Replace the existing model `<input>` block:

```tsx
{/* before: always a text input */}
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
```

With a conditional that renders `<select>` when the provider has a fixed list, `<input>` otherwise:

```tsx
<div className="space-y-1">
  <label className="text-xs text-text-muted">
    {def.availableModels ? 'Model' : 'Default model (optional)'}
  </label>
  {def.availableModels ? (
    <select
      value={defaultModel}
      onChange={(e) => setDefModel(e.target.value)}
      className={cn(inputCls, 'cursor-pointer')}
    >
      {def.availableModels.map((m) => (
        <option key={m} value={m}>{m}</option>
      ))}
    </select>
  ) : (
    <input
      type="text"
      value={defaultModel}
      onChange={(e) => setDefModel(e.target.value)}
      placeholder="gpt-4o"
      className={inputCls}
    />
  )}
</div>
```

- [ ] **Step 3: Add key-prefix hint below the API key input**

After the API key `<div className="flex gap-2">` closing tag (after the show/hide button), add:

```tsx
{def.keyPrefix && apiKey.startsWith(def.keyPrefix) && (
  <p className="text-xs text-green-400 mt-1">✓ {def.name} key detected</p>
)}
```

The full API key section becomes:

```tsx
<div className="space-y-1">
  <label className="text-xs text-text-muted">API Key</label>
  <div className="flex gap-2">
    <input
      type={showKey ? 'text' : 'password'}
      value={apiKey}
      onChange={(e) => setApiKey(e.target.value)}
      placeholder={state?.has_api_key ? 'Key saved — enter new key to update' : 'sk-...'}
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
  {def.keyPrefix && apiKey.startsWith(def.keyPrefix) && (
    <p className="text-xs text-green-400 mt-1">✓ {def.name} key detected</p>
  )}
</div>
```

- [ ] **Step 4: Check TypeScript**

```bash
cd frontend-react && npx tsc --noEmit
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add frontend-react/src/components/settings/ByokTab.tsx
git commit -m "feat(byok): model dropdown + key-prefix hint for Kimi, GLM, MiniMax"
```

---

## Task 4: Update ByokTab tests

**Files:**
- Modify: `frontend-react/src/components/settings/__tests__/ByokTab.test.tsx`

The existing tests break because:
- `'renders all 6 provider rows'` — now 11 rows
- `'unconfigured providers show "Not configured" badge'` — now expects 11 badges
- New behavior to test: model `<select>` for Kimi/GLM/MiniMax, key-prefix hint

- [ ] **Step 1: Update existing count assertions**

```typescript
it('renders all 11 provider rows', () => {
  render(<ByokTab />);
  expect(screen.getByText('OpenAI')).toBeInTheDocument();
  expect(screen.getByText('Anthropic')).toBeInTheDocument();
  expect(screen.getByText('Google Gemini')).toBeInTheDocument();
  expect(screen.getByText('Kimi')).toBeInTheDocument();
  expect(screen.getByText('GLM (Z.ai)')).toBeInTheDocument();
  expect(screen.getByText('MiniMax')).toBeInTheDocument();
  expect(screen.getByText('DeepSeek')).toBeInTheDocument();
  expect(screen.getByText('Groq')).toBeInTheDocument();
  expect(screen.getByText('Mistral')).toBeInTheDocument();
  expect(screen.getByText('OpenRouter')).toBeInTheDocument();
  expect(screen.getByText('Custom Endpoint')).toBeInTheDocument();
});

it('unconfigured providers show "Not configured" badge', () => {
  render(<ByokTab />);
  expect(screen.getAllByText('Not configured')).toHaveLength(11);
});
```

- [ ] **Step 2: Add model select test for MiniMax**

```typescript
it('MiniMax row shows a model <select> with MiniMax-M2.7 preselected', async () => {
  render(<ByokTab />);
  await userEvent.click(screen.getByText('MiniMax'));
  const select = await screen.findByRole('combobox');
  expect(select).toHaveValue('MiniMax-M2.7');
  const options = within(select as HTMLSelectElement).getAllByRole('option');
  expect(options.map((o) => o.textContent)).toEqual([
    'MiniMax-M2.7',
    'MiniMax-M2.7-highspeed',
    'MiniMax-M2.5',
    'MiniMax-M2.5-highspeed',
  ]);
});
```

Add `within` to the import: `import { render, screen, waitFor, within } from '@testing-library/react';`

- [ ] **Step 3: Add GLM model select test**

```typescript
it('GLM row shows a model <select> with glm-5.1 as first option', async () => {
  render(<ByokTab />);
  await userEvent.click(screen.getByText('GLM (Z.ai)'));
  const select = await screen.findByRole('combobox');
  expect(select).toHaveValue('glm-5.1');
});
```

- [ ] **Step 4: Add Kimi key-prefix hint test**

```typescript
it('Kimi shows key-detected hint when key starts with sk-kimi-', async () => {
  render(<ByokTab />);
  await userEvent.click(screen.getByText('Kimi'));
  const keyInput = await screen.findByPlaceholderText('sk-...');
  await userEvent.type(keyInput, 'sk-kimi-abc123');
  expect(screen.getByText('✓ Kimi key detected')).toBeInTheDocument();
});
```

- [ ] **Step 5: Add MiniMax key-prefix hint test**

```typescript
it('MiniMax shows key-detected hint when key starts with sk-cp-', async () => {
  render(<ByokTab />);
  await userEvent.click(screen.getByText('MiniMax'));
  const keyInput = await screen.findByPlaceholderText('sk-...');
  await userEvent.type(keyInput, 'sk-cp-tokenplan');
  expect(screen.getByText('✓ MiniMax key detected')).toBeInTheDocument();
});
```

- [ ] **Step 6: Add non-matching key does not show hint test**

```typescript
it('MiniMax does not show hint for non-MiniMax key', async () => {
  render(<ByokTab />);
  await userEvent.click(screen.getByText('MiniMax'));
  const keyInput = await screen.findByPlaceholderText('sk-...');
  await userEvent.type(keyInput, 'sk-other-key');
  expect(screen.queryByText('✓ MiniMax key detected')).not.toBeInTheDocument();
});
```

- [ ] **Step 7: Run the full test suite**

```bash
cd frontend-react && npm test -- --run
```

Expected: all tests pass, 0 failures.

- [ ] **Step 8: Commit**

```bash
git add frontend-react/src/components/settings/__tests__/ByokTab.test.tsx
git commit -m "test(byok): update provider count + add model-select and key-prefix tests"
```

---

## Self-Review Checklist

**Spec coverage:**
- [x] Kimi URL `https://api.kimi.com/coding/v1` — Task 1
- [x] GLM URL `https://api.z.ai/api/coding/paas/v4` — Task 1
- [x] MiniMax URL `https://api.minimax.io/v1` — Task 1
- [x] All three use `/chat/completions` — unchanged, already in `chat_cloud_stream`
- [x] `sk-kimi-` prefix detection — Task 3 + Task 4
- [x] `sk-cp-` prefix detection — Task 3 + Task 4
- [x] Model dropdown for Kimi (kimi-for-coding) — Task 2 + 3
- [x] Model dropdown for GLM (glm-5.1 etc.) — Task 2 + 3
- [x] Model dropdown for MiniMax (MiniMax-M2.7 etc.) — Task 2 + 3
- [x] No new abstractions / files — follows existing patterns

**Placeholder scan:** None found — all code blocks are complete.

**Type consistency:**
- `def.availableModels` typed as `readonly string[] | undefined` via `as const` on each entry — consistent across Task 2 and Task 3.
- `def.keyPrefix` typed as `string | undefined` — consistent.
- `defaultModel` `useState` initialization uses `def.availableModels[0]` which TypeScript infers as `string` because `availableModels` is checked for existence first.
