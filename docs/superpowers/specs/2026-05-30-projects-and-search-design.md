# Projects & Search — Design Spec

**Date:** 2026-05-30  
**Specs:** 5 (New Projects) & 6 (Search)  
**Approach:** Flat project metadata file (Approach A)

---

## 1. Data & Backend

### Rust — new Tauri commands (`src-tauri/src/`)

Three new commands added alongside the existing conversation commands:

```rust
save_project(id: String, name: String, conversation_ids: Vec<String>) -> Result<()>
load_projects() -> Result<Vec<ProjectSummary>>
delete_project(id: String) -> Result<()>
```

`ProjectSummary` struct (derives `Serialize`, `Deserialize`, `Clone`):
```rust
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub conversation_ids: Vec<String>,
}
```

Persisted as `projects.json` in the same data directory as conversations (resolved via `paths.rs`). Written atomically via `serde_json::to_string_pretty`. The file is an array of `ProjectSummary` objects.

Stale `conversation_id` entries (pointing to deleted conversations) are filtered out at the frontend render layer — no backend cleanup needed.

### Frontend types (`frontend-react/src/lib/tauri/index.ts`)

New type:
```ts
export interface Project { id: string; name: string; conversation_ids: string[] }
```

New raw invokes:
```ts
saveProject: (id: string, name: string, conversationIds: string[]) => invoke<void>('save_project', { id, name, conversationIds })
loadProjects: () => invoke<Project[]>('load_projects')
deleteProject: (id: string) => invoke<void>('delete_project', { id })
```

New `tauri.projects` facade group:
```ts
tauri.projects = {
  list:   async () => raw.loadProjects(),
  save:   async (id, name, ids) => raw.saveProject(id, name, ids),
  delete: async (id) => raw.deleteProject(id),
}
```

### `useProjects` store (`frontend-react/src/stores/projects.ts`)

Mirrors `useConversations` in structure:

```ts
interface ProjectsStore {
  list: Project[];
  refresh:    () => Promise<void>;
  create:     (name: string) => Promise<void>;
  delete:     (id: string) => Promise<void>;
  addChat:    (projectId: string, convId: string) => Promise<void>;
  removeChat: (projectId: string, convId: string) => Promise<void>;
}
```

- `create(name)` — generates a `crypto.randomUUID()` id, calls `tauri.projects.save`, then `refresh()`.
- `delete(id)` — calls `tauri.projects.delete`, then `refresh()`. Does NOT delete contained conversations — they re-appear in the flat Recent list.
- `addChat(projectId, convId)` — finds the project in `list`, adds `convId` to its `conversation_ids`, calls `tauri.projects.save` with the full updated list, then `refresh()`.
- `removeChat(projectId, convId)` — same as above but filters `convId` out.

All projects are loaded via `refresh()` on app boot (alongside conversations) in `main.tsx` or `AppShell.tsx`.

---

## 2. Sidebar UI

### Layout within the scrollable Recent section

Render order (top to bottom):

1. **Project folder rows** — one per project, rendered before the flat chat list.
2. **Flat Recent list** — all conversations whose `id` is NOT present in any project's `conversation_ids`, sorted by `updated_at` desc.

### Project folder row (`ProjectRow` component)

- Left: `Folder` icon + project name.
- Right: `...` button (visible on hover) → dropdown with **Rename** and **Delete project**.
  - Rename: opens the same shadcn `Dialog` as create, pre-filled with the current name; calls `projects.save` with the updated name and unchanged `conversation_ids`.
  - Delete project: calls `projects.delete`. Conversations are NOT deleted; they re-appear in the flat Recent list.
- Chevron toggles collapse/expand (state local to the component via `useState`).
- When expanded: indented `RecentRow` items for each conversation in `conversation_ids` that still exists (stale IDs filtered out).

### Chat row `...` menu

Every `RecentRow` gains a `...` button (visible on hover, right-aligned). Opens a dropdown:

- **Delete chat** — calls existing `conversations.delete`.
- **Add to project →** — submenu listing all projects by name.
  - Clicking a project calls `projects.addChat(projectId, convId)`.
  - If `projects.list` is empty: item is rendered grayed out with label "No projects yet".
- Chats inside a project folder also show this menu, with **Remove from project** replacing **Add to project**.

### "New Projects" sidebar item

- Remove `disabled: true` from the `MENU` entry.
- `onClick` for `action: 'newProject'` opens a shadcn `Dialog` with a single text input ("Project name") and a Create button.
- On submit: calls `projects.create(name)`, closes the dialog.

---

## 3. Search UI

### Trigger

- Remove `disabled: true` from the Search `MENU` entry.
- `onClick` dispatches `new CustomEvent('feral:open-search')`.
- Keyboard shortcut `⌘K` / `Ctrl+K` also dispatches the same event (wired in `useGlobalHotkeys.ts`).
- `AppShell.tsx` listens for `feral:open-search` and sets `searchOpen: true` in `useUI`.

### State

Add to `useUI` store:
```ts
searchOpen: boolean;
openSearch:  () => void;
closeSearch: () => void;
```

### Overlay (`SearchOverlay` component)

- `position: fixed`, full viewport, `z-50`.
- Background: `backdrop-blur-md` + `bg-black/40`.
- Clicking the backdrop closes the overlay.
- `Escape` key closes the overlay.

**Pill input:**
- Centered horizontally and positioned ~20% from the top.
- `rounded-3xl`, ~600px wide, ~52px tall, `bg-bg-surface` with a subtle border.
- Left: `Search` icon (muted). Right: `×` close button.
- Autofocused on open.

**Results list** (below the pill, same width):
- Max height `60vh`, scrollable.
- Each result row:
  - Conversation title (bold).
  - Matching message snippet with keyword highlighted (wrap in `<mark>` styled with accent color).
  - Relative timestamp (e.g. "2 days ago").
- Clicking a row: closes overlay, navigates to `/chat`, opens the conversation via `conversations.open(id)`.
- Empty state: "No matches found" in muted text, centered.

### Search logic

- Debounced 150ms after keystroke.
- On first search: call `tauri.conversations.list()` for all summaries (titles + IDs).
- Title matches are shown immediately.
- Full message content is loaded per-conversation via `tauri.conversations.load(id)` in the background, progressively enriching results with message snippets as content loads.
- Matching: case-insensitive substring match on title and message content.
- Results ordered: title matches first, then message-content-only matches.
- The content cache is local to the overlay's lifetime — no persistent caching.

---

## Out of Scope

- Project ordering/drag-to-reorder (future).
- Project colors or icons (future).
- Full-text indexing on the Rust side (client-side search is sufficient for expected chat volumes).
- Multi-project membership (a chat belongs to at most one project).
