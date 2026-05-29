# Chat Input Buttons — Design Spec
Date: 2026-05-29

## Overview

Make the three toolbar buttons in `ChatInput` functional:
- **Paperclip** — file attachment (any format, chip UI)
- **Wrench** — per-tool toggles (web_search, http_request, file_read, file_write, code_execute)
- **Brain** — reasoning mode cycle (Auto / On / Off)

---

## 1. State Architecture

### 1.1 `useUI` store additions (persisted via zustand/persist)

```ts
type ReasoningMode = 'auto' | 'on' | 'off';
type ToolId = 'web_search' | 'http_request' | 'file_read' | 'file_write' | 'code_execute';

// New fields added to UIStore:
reasoningMode: ReasoningMode;          // default: 'auto'
enabledTools: ToolId[];                // default: []
setReasoningMode: (m: ReasoningMode) => void;
cycleReasoningMode: () => void;        // auto → on → off → auto
toggleTool: (id: ToolId) => void;
```

Both fields are included in `partialize` so they persist across sessions.

### 1.2 `ChatInput` local state (per-session, not persisted)

```ts
const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);

interface AttachedFile {
  name: string;
  path: string;
  content: string | null;  // null = binary/unreadable
  error?: string;
}
```

Files reset to `[]` after each send.

---

## 2. Paperclip — File Attachment

### 2.1 New dependencies

- `src-tauri/Cargo.toml`: `tauri-plugin-dialog = "2"`
- `frontend-react/package.json`: `@tauri-apps/plugin-dialog`
- `src-tauri/tauri.conf.json` permissions: add `"dialog:default"`
- `src-tauri/src/lib.rs`: `.plugin(tauri_plugin_dialog::init())`

### 2.2 UI layout

```
┌─────────────────────────────────────────────┐
│ 📎 report.pdf ×   code.rs ×                 │  ← chips row (hidden when empty)
├─────────────────────────────────────────────┤
│ Ask anything…                               │
│                                             │
├─────────────────────────────────────────────┤
│ 📎  🔧  🧠      [Qwen3.5…▾]  [↑]          │
└─────────────────────────────────────────────┘
```

Chips row sits between the rounded border top and the textarea, only rendered when `attachedFiles.length > 0`.

### 2.3 Flow

1. Click paperclip → `open({ multiple: true, filters: [] })` — native OS file picker, any format
2. For each selected file: attempt `readTextFile(path)`
   - Success → `{ name, path, content: string }`
   - Failure (binary/permission) → `{ name, path, content: null, error: "Unsupported format" }`
3. Chips appear immediately. Each chip: `filename ×` button to remove
4. Error chips: rendered with `text-rose-400`, tooltip shows the error message
5. On send: files with valid `content` are prepended to user message text:
   ```
   [File: filename.txt]
   <content>

   <user text>
   ```
   Files with `content: null` are silently omitted (chip already shows error state)
6. `attachedFiles` resets to `[]` after send

### 2.4 New components

- `frontend-react/src/components/chat/AttachedFileChip.tsx` — single chip with name, remove button, error state
- `frontend-react/src/components/chat/FileAttachButton.tsx` — handles dialog open + file reading, calls `setAttachedFiles`

---

## 3. Wrench — Tools Popover

### 3.1 UI

```
  ┌──────────────────────────┐
  │ Tools                    │
  ├──────────────────────────┤
  │ 🔍 Web Search      [●]   │
  │ 🌐 HTTP Request    [○]   │
  │ 📂 File Read       [○]   │
  │ ✏️  File Write      [○]   │
  │ ⚡ Code Execute    [○]   │
  └──────────────────────────┘
       ↑ opens above Wrench button
```

- Radix `Popover` with `side="top"`, `align="start"`
- Each row: icon + label + shadcn `Switch`
- Wrench button color: `text-brand` if `enabledTools.length > 0`, else `text-text-muted`
- Small numeric badge on button when tools are active (e.g. `🔧` with `²` superscript)

### 3.2 Tool definitions (frontend-side constant)

```ts
const TOOLS = [
  { id: 'web_search',    label: 'Web Search',    icon: Search },
  { id: 'http_request',  label: 'HTTP Request',  icon: Globe },
  { id: 'file_read',     label: 'File Read',     icon: FolderOpen },
  { id: 'file_write',    label: 'File Write',    icon: Pencil },
  { id: 'code_execute',  label: 'Code Execute',  icon: Zap },
] as const;
```

### 3.3 Behavior

- Toggle calls `useUI.toggleTool(id)` — adds/removes from `enabledTools[]`
- Active tools are passed as metadata in the future agent call; for now they are stored in `useUI` and read by `useSendMessage` (no runtime effect yet — groundwork for AgentConfig wiring)
- Popover closes on outside click (Radix default)

### 3.4 New component

- `frontend-react/src/components/chat/ToolsPopover.tsx`

---

## 4. Brain — Reasoning Mode

### 4.1 States and visual design

| State | Icon color | Badge | Badge color |
|-------|-----------|-------|-------------|
| `auto` | `text-sky-400` | `A` | gray subtle |
| `on` | `text-emerald-400` | `ON` | green |
| `off` | `text-rose-400` | `OFF` | red subtle |

Badge is 8px text positioned bottom-right on the icon. Click cycles: `auto → on → off → auto`.

### 4.2 Reasoning logic per state

| State | Condition | `enableThinking` result |
|-------|-----------|------------------------|
| `auto` | `modelSupportsThinking(loadedModel.name)` returns true | `true` |
| `auto` | model name doesn't match | `false` |
| `on`   | always | `true` |
| `off`  | always | `false` |

`modelSupportsThinking(name: string): boolean` — added to `lib/modelUtils.ts`.  
Matches (case-insensitive): `think`, `qwq`, `deepseek-r`, `mistral.*think`.

### 4.3 Effect when `enableThinking = true`

`currentInferParams` appends to `system_prompt`:
```
\n\nThink step by step inside <think>...</think> before answering.
```

### 4.4 Effect when `enableThinking = false` and mode = `off`

A `hideThinking` flag is passed to `MessageItem` → `ThinkingBlock` is not rendered even if the model emits `<think>` content. The `thinking` field on `ChatMessage` is still stored (not filtered) so toggling Off doesn't destroy data.

### 4.5 Files modified

- `stores/ui.ts` — `reasoningMode`, `cycleReasoningMode`
- `lib/modelUtils.ts` — `modelSupportsThinking()`
- `lib/inferParams.ts` — accepts `{ reasoningMode, modelName }`, computes `enableThinking`
- `hooks/useSendMessage.ts` — reads `useUI` reasoning state + loaded model name, passes to `currentInferParams`
- `components/chat/ChatInput.tsx` — Brain button with badge + color, `cycleReasoningMode` on click
- `components/chat/MessageItem.tsx` — passes `hideThinking` prop based on current `reasoningMode`

---

## 5. Files Changed Summary

### New files
| File | Purpose |
|------|---------|
| `components/chat/AttachedFileChip.tsx` | File chip UI |
| `components/chat/FileAttachButton.tsx` | File picker logic |
| `components/chat/ToolsPopover.tsx` | Tools toggle popover |

### Modified files
| File | Change |
|------|--------|
| `stores/ui.ts` | Add `reasoningMode`, `enabledTools`, actions |
| `lib/inferParams.ts` | Accept reasoning opts, compute `enableThinking` |
| `lib/modelUtils.ts` | Add `modelSupportsThinking()` |
| `hooks/useSendMessage.ts` | Read reasoning/tools from store, pass to params |
| `components/chat/ChatInput.tsx` | Wire up all 3 buttons, add chips row |
| `components/chat/MessageItem.tsx` | Pass `hideThinking` when mode=off |
| `src-tauri/Cargo.toml` | Add `tauri-plugin-dialog` |
| `src-tauri/src/lib.rs` | Register dialog plugin |
| `src-tauri/tauri.conf.json` | Add `dialog:default` permission |
| `frontend-react/package.json` | Add `@tauri-apps/plugin-dialog` |

---

## 6. Out of Scope

- Runtime tool execution wired to AgentConfig (tools toggle is UI groundwork only)
- PDF/binary file parsing (binary files show error chip, content not sent)
- Reasoning mode affecting token sampling params (e.g. temperature change for thinking models)
