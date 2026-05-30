# Projects & Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Projects (folder-based chat grouping pinned in sidebar) and Search (full-screen keyword search overlay across all conversations) as described in the spec.

**Architecture:** Flat `projects.json` file on disk via three new Rust Tauri commands; mirrored by a `useProjects` zustand store on the frontend. Projects render as collapsible folder rows at the top of the Recent section; chats gain a `...` dropdown menu. Search is a full-screen overlay driven by `useUI.searchOpen`, loading conversation content lazily via existing `tauri.conversations.load`.

**Tech Stack:** Rust/Tauri (serde_json, anyhow), React 18, Zustand, Framer Motion, Radix UI (shadcn dropdown-menu, dialog), Lucide icons, TypeScript.

---

## File Map

| Action  | Path |
|---------|------|
| Create  | `src-tauri/src/projects.rs` |
| Modify  | `src-tauri/src/lib.rs` |
| Modify  | `src-tauri/src/paths.rs` |
| Modify  | `frontend-react/src/lib/tauri/index.ts` |
| Create  | `frontend-react/src/stores/projects.ts` |
| Modify  | `frontend-react/src/stores/ui.ts` |
| Create  | `frontend-react/src/components/chat/SearchOverlay.tsx` |
| Modify  | `frontend-react/src/components/layout/Sidebar.tsx` |
| Modify  | `frontend-react/src/components/layout/AppShell.tsx` |
| Modify  | `frontend-react/src/hooks/useGlobalHotkeys.ts` |
| Modify  | `frontend-react/src/pages/ChatPage.tsx` |

---

## Task 1: Rust — `projects.rs` module

**Files:**
- Create: `src-tauri/src/projects.rs`
- Modify: `src-tauri/src/paths.rs` (add `projects_path`)
- Modify: `src-tauri/src/lib.rs` (add module, commands, register)

- [ ] **Step 1: Write failing Rust tests (in `projects.rs` before the impl)**

Create `src-tauri/src/projects.rs` with the test module at the bottom:

```rust
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::paths;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub conversation_ids: Vec<String>,
}

fn projects_path_for(dir: &Path) -> PathBuf {
    dir.join("projects.json")
}

pub fn load_all_from(dir: &Path) -> Result<Vec<ProjectSummary>> {
    let path = projects_path_for(dir);
    if !path.exists() {
        return Ok(vec![]);
    }
    let bytes = std::fs::read(&path)?;
    Ok(serde_json::from_slice(&bytes)?)
}

pub fn save_to(dir: &Path, project: &ProjectSummary) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let mut list = load_all_from(dir)?;
    match list.iter_mut().find(|p| p.id == project.id) {
        Some(existing) => *existing = project.clone(),
        None => list.push(project.clone()),
    }
    std::fs::write(projects_path_for(dir), serde_json::to_vec_pretty(&list)?)?;
    Ok(())
}

pub fn delete_from(dir: &Path, id: &str) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let mut list = load_all_from(dir)?;
    list.retain(|p| p.id != id);
    std::fs::write(projects_path_for(dir), serde_json::to_vec_pretty(&list)?)?;
    Ok(())
}

// ── Tauri-facing wrappers ──────────────────────────────────────────────────────

pub fn load_all() -> Result<Vec<ProjectSummary>> {
    paths::ensure_dirs()?;
    load_all_from(&paths::feral_dir())
}

pub fn save(project: &ProjectSummary) -> Result<()> {
    paths::ensure_dirs()?;
    save_to(&paths::feral_dir(), project)
}

pub fn delete(id: &str) -> Result<()> {
    paths::ensure_dirs()?;
    delete_from(&paths::feral_dir(), id)
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("feral_proj_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn proj(id: &str, name: &str, ids: Vec<&str>) -> ProjectSummary {
        ProjectSummary {
            id: id.to_string(),
            name: name.to_string(),
            conversation_ids: ids.into_iter().map(String::from).collect(),
        }
    }

    #[test]
    fn empty_dir_returns_empty_list() {
        let dir = tmp();
        assert!(load_all_from(&dir).unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_and_load_roundtrip() {
        let dir = tmp();
        save_to(&dir, &proj("p1", "Work", vec!["c1", "c2"])).unwrap();
        let list = load_all_from(&dir).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "p1");
        assert_eq!(list[0].name, "Work");
        assert_eq!(list[0].conversation_ids, vec!["c1", "c2"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_upserts_without_duplicating() {
        let dir = tmp();
        save_to(&dir, &proj("p1", "Work", vec!["c1"])).unwrap();
        save_to(&dir, &proj("p1", "Work Renamed", vec!["c1", "c2"])).unwrap();
        let list = load_all_from(&dir).unwrap();
        assert_eq!(list.len(), 1, "should still be one project after upsert");
        assert_eq!(list[0].name, "Work Renamed");
        assert_eq!(list[0].conversation_ids.len(), 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn delete_removes_project_from_list() {
        let dir = tmp();
        save_to(&dir, &proj("p1", "Alpha", vec![])).unwrap();
        save_to(&dir, &proj("p2", "Beta", vec![])).unwrap();
        delete_from(&dir, "p1").unwrap();
        let list = load_all_from(&dir).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "p2");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn delete_nonexistent_is_noop() {
        let dir = tmp();
        save_to(&dir, &proj("p1", "Alpha", vec![])).unwrap();
        delete_from(&dir, "ghost").unwrap();
        assert_eq!(load_all_from(&dir).unwrap().len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }
}
```

- [ ] **Step 2: Run the tests (they will fail — module not wired yet)**

```powershell
cd src-tauri && cargo test projects -- --nocapture 2>&1
```

Expected: compile error — `mod projects` not declared in `lib.rs`.

- [ ] **Step 3: Add `mod projects;` to `lib.rs` and the three Tauri commands**

In `src-tauri/src/lib.rs`, after `mod paths;` add:

```rust
mod projects;
```

After the `clear_all_conversations` command block (around line 738), add:

```rust
// ---------- Projects ----------

#[tauri::command]
#[specta::specta]
fn load_projects() -> Result<Vec<projects::ProjectSummary>, String> {
    projects::load_all().map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
fn save_project(id: String, name: String, conversation_ids: Vec<String>) -> Result<(), String> {
    projects::save(&projects::ProjectSummary { id, name, conversation_ids })
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
fn delete_project(id: String) -> Result<(), String> {
    projects::delete(&id).map_err(|e| e.to_string())
}
```

Then in the `collect_commands!` macro (around line 1164), add after `clear_all_conversations`:

```rust
load_projects,
save_project,
delete_project,
```

- [ ] **Step 4: Run tests again — they should pass**

```powershell
cd src-tauri && cargo test projects -- --nocapture 2>&1
```

Expected:
```
test projects::tests::empty_dir_returns_empty_list ... ok
test projects::tests::save_and_load_roundtrip ... ok
test projects::tests::save_upserts_without_duplicating ... ok
test projects::tests::delete_removes_project_from_list ... ok
test projects::tests::delete_nonexistent_is_noop ... ok
test result: ok. 5 passed; 0 failed
```

- [ ] **Step 5: Verify the full Rust test suite still passes**

```powershell
cd src-tauri && cargo test 2>&1
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/projects.rs src-tauri/src/lib.rs
git commit -m "feat(rust): add projects CRUD — save_project, load_projects, delete_project"
```

---

## Task 2: Frontend — `Project` type + `tauri.projects` facade

**Files:**
- Modify: `frontend-react/src/lib/tauri/index.ts`

- [ ] **Step 1: Add `Project` interface after `ConversationSummary` (line 98)**

```ts
export interface Project { id: string; name: string; conversation_ids: string[] }
```

- [ ] **Step 2: Add three raw invokes after `clearAllConversations` in the `raw` object (around line 134)**

```ts
loadProjects:   () =>
  invoke<Project[]>('load_projects'),
saveProject:    (id: string, name: string, conversationIds: string[]) =>
  invoke<void>('save_project', { id, name, conversationIds }),
deleteProject:  (id: string) =>
  invoke<void>('delete_project', { id }),
```

- [ ] **Step 3: Add `tauri.projects` facade group after `tauri.conversations` (around line 169)**

```ts
projects: {
  list:   async () => raw.loadProjects(),
  save:   async (id: string, name: string, ids: string[]) =>
    raw.saveProject(id, name, ids),
  delete: async (id: string) => raw.deleteProject(id),
},
```

- [ ] **Step 4: Verify TypeScript compiles**

```powershell
cd frontend-react && npx tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add frontend-react/src/lib/tauri/index.ts
git commit -m "feat(tauri): add Project type + projects facade (list, save, delete)"
```

---

## Task 3: `useProjects` store

**Files:**
- Create: `frontend-react/src/stores/projects.ts`

- [ ] **Step 1: Create the store**

```ts
import { create } from 'zustand';
import { tauri, type Project } from '@/lib/tauri';

export type { Project };

interface ProjectsStore {
  list: Project[];
  refresh:    () => Promise<void>;
  create:     (name: string) => Promise<void>;
  delete:     (id: string) => Promise<void>;
  rename:     (id: string, name: string) => Promise<void>;
  addChat:    (projectId: string, convId: string) => Promise<void>;
  removeChat: (projectId: string, convId: string) => Promise<void>;
}

export const useProjects = create<ProjectsStore>((set, get) => ({
  list: [],

  refresh: async () => {
    const list = await tauri.projects.list();
    set({ list });
  },

  create: async (name) => {
    const id = crypto.randomUUID();
    await tauri.projects.save(id, name, []);
    await get().refresh();
  },

  delete: async (id) => {
    await tauri.projects.delete(id);
    await get().refresh();
  },

  rename: async (id, name) => {
    const project = get().list.find((p) => p.id === id);
    if (!project) return;
    await tauri.projects.save(id, name, project.conversation_ids);
    await get().refresh();
  },

  addChat: async (projectId, convId) => {
    const project = get().list.find((p) => p.id === projectId);
    if (!project) return;
    if (project.conversation_ids.includes(convId)) return;
    await tauri.projects.save(projectId, project.name, [...project.conversation_ids, convId]);
    await get().refresh();
  },

  removeChat: async (projectId, convId) => {
    const project = get().list.find((p) => p.id === projectId);
    if (!project) return;
    await tauri.projects.save(projectId, project.name,
      project.conversation_ids.filter((id) => id !== convId));
    await get().refresh();
  },
}));
```

- [ ] **Step 2: Verify TypeScript compiles**

```powershell
cd frontend-react && npx tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend-react/src/stores/projects.ts
git commit -m "feat(store): add useProjects store (refresh, create, delete, rename, addChat, removeChat)"
```

---

## Task 4: Boot hydration — load projects on startup

**Files:**
- Modify: `frontend-react/src/pages/ChatPage.tsx`

- [ ] **Step 1: Add `useProjects` import and `refresh()` call**

In `ChatPage.tsx`, add the import at the top:

```ts
import { useProjects } from '@/stores/projects';
```

In the `useEffect` that hydrates on mount (currently around line 42–45):

```ts
useEffect(() => {
  void useConversations.getState().refresh();
  void useProjects.getState().refresh();
  void useModel.getState().refresh();
}, []);
```

- [ ] **Step 2: Verify TypeScript compiles**

```powershell
cd frontend-react && npx tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend-react/src/pages/ChatPage.tsx
git commit -m "feat(boot): load projects alongside conversations on app start"
```

---

## Task 5: `useUI` — add search open/close state

**Files:**
- Modify: `frontend-react/src/stores/ui.ts`

- [ ] **Step 1: Add `searchOpen`, `openSearch`, `closeSearch` to the interface and implementation**

In `ui.ts`, add to the `UIStore` interface (after `toggleTool`):

```ts
searchOpen:  boolean;
openSearch:  () => void;
closeSearch: () => void;
```

In the `create` call (after `toggleTool` implementation):

```ts
searchOpen: false,
openSearch:  () => set({ searchOpen: true }),
closeSearch: () => set({ searchOpen: false }),
```

`searchOpen` must NOT appear in the `partialize` list (it's transient).

- [ ] **Step 2: Verify TypeScript compiles**

```powershell
cd frontend-react && npx tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend-react/src/stores/ui.ts
git commit -m "feat(ui-store): add searchOpen + openSearch/closeSearch actions"
```

---

## Task 6: `SearchOverlay` component

**Files:**
- Create: `frontend-react/src/components/chat/SearchOverlay.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useUI } from '@/stores/ui';
import { useConversations, type ConversationSummary } from '@/stores/conversations';
import { tauri, type Conversation } from '@/lib/tauri';

interface SearchResult {
  conv: ConversationSummary;
  snippet: string | null;
}

function highlight(text: string, query: string): React.ReactNode {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-brand/30 text-text-primary rounded-sm not-italic">
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  );
}

function relativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins  = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days  = Math.floor(diff / 86_400_000);
  if (mins  < 1)  return 'just now';
  if (mins  < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days  < 30) return `${days}d ago`;
  return new Date(isoString).toLocaleDateString();
}

export function SearchOverlay() {
  const closeSearch = useUI((s) => s.closeSearch);
  const navigate    = useNavigate();
  const convOpen    = useConversations((s) => s.open);
  const allConvs    = useConversations((s) => s.list);

  const [query, setQuery]     = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const inputRef              = useRef<HTMLInputElement>(null);
  const cacheRef              = useRef<Map<string, Conversation>>(new Map());
  const debounceRef           = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const runSearch = useCallback(async (q: string) => {
    if (!q.trim()) { setResults([]); return; }
    const lower = q.toLowerCase();

    // Immediate title matches
    const titleMatches = allConvs
      .filter((c) => c.title.toLowerCase().includes(lower))
      .map((c): SearchResult => ({ conv: c, snippet: null }));
    setResults(titleMatches);

    // Load uncached full conversations in background
    const uncached = allConvs.filter((c) => !cacheRef.current.has(c.id));
    await Promise.all(
      uncached.map(async (c) => {
        try {
          const full = await tauri.conversations.load(c.id);
          cacheRef.current.set(c.id, full);
        } catch { /* skip unloadable convs */ }
      }),
    );

    // Re-run with full content
    const titleMatchIds = new Set(titleMatches.map((r) => r.conv.id));
    const final: SearchResult[] = [...titleMatches];

    for (const c of allConvs) {
      if (titleMatchIds.has(c.id)) continue;
      const full = cacheRef.current.get(c.id);
      if (!full) continue;
      for (const msg of full.messages) {
        const idx = msg.content.toLowerCase().indexOf(lower);
        if (idx !== -1) {
          const start = Math.max(0, idx - 40);
          const end   = Math.min(msg.content.length, idx + q.length + 60);
          const snip  = (start > 0 ? '…' : '') +
            msg.content.slice(start, end) +
            (end < msg.content.length ? '…' : '');
          final.push({ conv: c, snippet: snip });
          break;
        }
      }
    }
    setResults(final);
  }, [allConvs]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { void runSearch(query); }, 150);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, runSearch]);

  const handleSelect = async (convId: string) => {
    closeSearch();
    navigate('/chat');
    await convOpen(convId);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center pt-[15vh] backdrop-blur-md bg-black/40"
      onClick={closeSearch}
    >
      <div
        className="w-full max-w-[600px] px-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Pill input */}
        <div className="flex items-center gap-3 bg-bg-surface border border-bg-hover rounded-3xl px-4 h-[52px] shadow-xl">
          <Search size={18} className="text-text-muted shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') closeSearch(); }}
            placeholder="Search conversations…"
            className="flex-1 bg-transparent text-text-primary text-sm outline-none placeholder:text-text-muted"
          />
          <button
            onClick={closeSearch}
            className="text-text-muted hover:text-text-secondary shrink-0"
            aria-label="Close search"
          >
            <X size={18} />
          </button>
        </div>

        {/* Results */}
        {query.trim() && (
          <div className="mt-2 bg-bg-surface border border-bg-hover rounded-2xl overflow-hidden shadow-xl max-h-[60vh] overflow-y-auto">
            {results.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-text-disabled">
                No matches found
              </div>
            ) : (
              results.map((r) => (
                <button
                  key={r.conv.id}
                  type="button"
                  onClick={() => { void handleSelect(r.conv.id); }}
                  className="w-full text-left px-4 py-3 hover:bg-bg-hover transition-colors border-b border-bg-hover last:border-0"
                >
                  <div className="text-sm font-medium text-text-primary truncate">
                    {highlight(r.conv.title, query)}
                  </div>
                  {r.snippet && (
                    <div className="text-xs text-text-muted mt-0.5 line-clamp-2">
                      {highlight(r.snippet, query)}
                    </div>
                  )}
                  <div className="text-[11px] text-text-disabled mt-0.5">
                    {relativeTime(r.conv.updated_at)}
                  </div>
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```powershell
cd frontend-react && npx tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend-react/src/components/chat/SearchOverlay.tsx
git commit -m "feat(search): add SearchOverlay component with debounced full-text search"
```

---

## Task 7: Wire up search — `AppShell` + `useGlobalHotkeys`

**Files:**
- Modify: `frontend-react/src/components/layout/AppShell.tsx`
- Modify: `frontend-react/src/hooks/useGlobalHotkeys.ts`

- [ ] **Step 1: Mount `SearchOverlay` in `AppShell.tsx`**

Replace the full content of `AppShell.tsx`:

```tsx
import { Outlet } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useUI, useSystemThemeSync } from '@/stores/ui';
import { useGlobalHotkeys } from '@/hooks/useGlobalHotkeys';
import { Sidebar, SIDEBAR_W, SIDEBAR_COLLAPSED_W } from './Sidebar';
import { SearchOverlay } from '@/components/chat/SearchOverlay';

export function AppShell() {
  useSystemThemeSync();
  useGlobalHotkeys();

  const collapsed   = useUI((s) => s.sidebarCollapsed);
  const searchOpen  = useUI((s) => s.searchOpen);

  return (
    <div className="h-screen w-screen flex bg-bg-primary text-text-primary overflow-hidden">
      <Sidebar />
      <motion.main
        animate={{ marginLeft: collapsed ? SIDEBAR_COLLAPSED_W : SIDEBAR_W }}
        transition={{ duration: 0.22, ease: 'easeInOut' }}
        className="flex-1 flex flex-col min-w-0"
      >
        <Outlet />
      </motion.main>
      {searchOpen && <SearchOverlay />}
    </div>
  );
}
```

- [ ] **Step 2: Wire `⌘K` / `Ctrl+K` in `useGlobalHotkeys.ts`**

Replace the full content of `useGlobalHotkeys.ts`:

```ts
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

export function useGlobalHotkeys() {
  const navigate = useNavigate();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      const target = e.target as HTMLElement | null;
      const inEditable =
        target != null &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);

      if (e.key.toLowerCase() === 'n' && !inEditable) {
        e.preventDefault();
        navigate('/chat');
        window.dispatchEvent(new CustomEvent('feral:new-chat'));
      }

      if (e.key.toLowerCase() === 'k') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('feral:open-search'));
      }
    };

    const searchHandler = () => {
      import('@/stores/ui').then(({ useUI }) => {
        useUI.getState().openSearch();
      });
    };

    window.addEventListener('keydown', handler);
    window.addEventListener('feral:open-search', searchHandler);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('feral:open-search', searchHandler);
    };
  }, [navigate]);
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```powershell
cd frontend-react && npx tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend-react/src/components/layout/AppShell.tsx frontend-react/src/hooks/useGlobalHotkeys.ts
git commit -m "feat(search): wire SearchOverlay into AppShell, bind Ctrl+K/Cmd+K hotkey"
```

---

## Task 8: Sidebar overhaul — Projects, chat menus, New Project dialog

**Files:**
- Modify: `frontend-react/src/components/layout/Sidebar.tsx`

This is a full rewrite of `Sidebar.tsx`. Replace the entire file:

- [ ] **Step 1: Replace `Sidebar.tsx` with the new implementation**

```tsx
import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  MessageSquare, FolderPlus, Search, Box, Settings, Sparkles, Bot,
  Download, PanelLeftClose, PanelLeftOpen, Lock, Folder,
  ChevronDown, ChevronRight, MoreHorizontal, Trash2, FolderInput, FolderMinus,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub,
  DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useUI } from '@/stores/ui';
import { useConversations, type ConversationSummary } from '@/stores/conversations';
import { useProjects, type Project } from '@/stores/projects';

export const SIDEBAR_W = 240;
export const SIDEBAR_COLLAPSED_W = 56;

type MenuAction = 'newChat' | 'newProject' | 'search' | 'models' | 'settings' | 'skills' | 'agents';

interface MenuItem {
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
  label: string;
  shortcut: string | null;
  action: MenuAction;
  disabled: boolean;
  route?: string;
}

const MENU: MenuItem[] = [
  { icon: MessageSquare, label: 'New Chat',    shortcut: '⌘N', action: 'newChat',    disabled: false, route: '/chat' },
  { icon: FolderPlus,   label: 'New Project',  shortcut: '⌘P', action: 'newProject', disabled: false },
  { icon: Search,       label: 'Search',       shortcut: '⌘K', action: 'search',     disabled: false },
  { icon: Box,          label: 'Models',       shortcut: null,  action: 'models',     disabled: false, route: '/models' },
  { icon: Settings,     label: 'Settings',     shortcut: null,  action: 'settings',   disabled: false, route: '/settings' },
  { icon: Sparkles,     label: 'Skills',       shortcut: null,  action: 'skills',     disabled: true,  route: '/skills' },
  { icon: Bot,          label: 'Agents',       shortcut: null,  action: 'agents',     disabled: true,  route: '/agents' },
];

// ── Sidebar root ───────────────────────────────────────────────────────────────

export function Sidebar() {
  const collapsed    = useUI((s) => s.sidebarCollapsed);
  const toggleSidebar = useUI((s) => s.toggleSidebar);
  const openSearch   = useUI((s) => s.openSearch);

  // New Project dialog state
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [projectNameDraft, setProjectNameDraft] = useState('');

  // Rename Project dialog state
  const [renameTarget, setRenameTarget] = useState<Project | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  const handleMenuAction = (action: MenuAction) => {
    if (action === 'newProject') {
      setProjectNameDraft('');
      setNewProjectOpen(true);
    } else if (action === 'search') {
      openSearch();
    }
  };

  const handleCreateProject = async () => {
    const name = projectNameDraft.trim();
    if (!name) return;
    await useProjects.getState().create(name);
    setNewProjectOpen(false);
  };

  const handleRenameProject = async () => {
    const name = renameDraft.trim();
    if (!name || !renameTarget) return;
    await useProjects.getState().rename(renameTarget.id, name);
    setRenameTarget(null);
  };

  return (
    <TooltipProvider delayDuration={300}>
      <motion.aside
        animate={{ width: collapsed ? SIDEBAR_COLLAPSED_W : SIDEBAR_W }}
        transition={{ duration: 0.22, ease: 'easeInOut' }}
        className="fixed inset-y-0 left-0 bg-bg-surface flex flex-col z-20 overflow-hidden"
      >
        {/* Header */}
        <div className="h-12 px-3 flex items-center justify-between shrink-0">
          {!collapsed && (
            <span className="font-semibold text-text-primary text-sm select-none">Feral</span>
          )}
          <div className={cn('flex gap-1', collapsed && 'mx-auto')}>
            {!collapsed && (
              <button
                className="p-1.5 rounded hover:bg-bg-hover text-text-muted hover:text-text-secondary"
                aria-label="Downloads"
              >
                <Download size={16} />
              </button>
            )}
            <button
              onClick={toggleSidebar}
              className="p-1.5 rounded hover:bg-bg-hover text-text-muted hover:text-text-secondary"
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </button>
          </div>
        </div>

        {/* Primary menu */}
        <nav className="px-2 py-2 space-y-0.5 shrink-0">
          {MENU.map((item) => (
            <MenuRow
              key={item.action}
              item={item}
              collapsed={collapsed}
              onAction={handleMenuAction}
            />
          ))}
        </nav>

        {/* Recent conversations + projects */}
        <div className="flex-1 overflow-y-auto px-2 pt-2 min-h-0">
          <AnimatePresence>
            {!collapsed && (
              <RecentSection
                onRenameProject={(p) => {
                  setRenameDraft(p.name);
                  setRenameTarget(p);
                }}
              />
            )}
          </AnimatePresence>
        </div>

        {/* Footer */}
        <div className="px-3 py-2 shrink-0">
          <AnimatePresence>
            {!collapsed && (
              <motion.span
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="text-[11px] text-text-muted select-none"
              >
                v0.1.0
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      </motion.aside>

      {/* New Project dialog */}
      <Dialog open={newProjectOpen} onOpenChange={setNewProjectOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New Project</DialogTitle>
          </DialogHeader>
          <input
            autoFocus
            value={projectNameDraft}
            onChange={(e) => setProjectNameDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleCreateProject(); }}
            placeholder="Project name"
            className="w-full rounded-md border border-bg-hover bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:ring-1 focus:ring-brand placeholder:text-text-muted"
          />
          <DialogFooter>
            <button
              onClick={() => setNewProjectOpen(false)}
              className="px-3 py-1.5 text-sm rounded text-text-muted hover:bg-bg-hover"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleCreateProject()}
              disabled={!projectNameDraft.trim()}
              className="px-3 py-1.5 text-sm rounded bg-brand text-white disabled:opacity-40"
            >
              Create
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename Project dialog */}
      <Dialog open={!!renameTarget} onOpenChange={(open) => { if (!open) setRenameTarget(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename Project</DialogTitle>
          </DialogHeader>
          <input
            autoFocus
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleRenameProject(); }}
            placeholder="Project name"
            className="w-full rounded-md border border-bg-hover bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:ring-1 focus:ring-brand placeholder:text-text-muted"
          />
          <DialogFooter>
            <button
              onClick={() => setRenameTarget(null)}
              className="px-3 py-1.5 text-sm rounded text-text-muted hover:bg-bg-hover"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleRenameProject()}
              disabled={!renameDraft.trim()}
              className="px-3 py-1.5 text-sm rounded bg-brand text-white disabled:opacity-40"
            >
              Save
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}

// ── MenuRow ────────────────────────────────────────────────────────────────────

function MenuRow({
  item, collapsed, onAction,
}: {
  item: MenuItem;
  collapsed: boolean;
  onAction: (action: MenuAction) => void;
}) {
  const navigate = useNavigate();
  const Icon = item.icon;

  const onClick = () => {
    if (item.disabled) return;
    if (item.action === 'newChat') {
      navigate('/chat');
      window.dispatchEvent(new CustomEvent('feral:new-chat'));
      return;
    }
    if (item.action === 'newProject' || item.action === 'search') {
      onAction(item.action);
      return;
    }
    if (item.route) navigate(item.route);
  };

  const row = (
    <button
      type="button"
      onClick={onClick}
      disabled={item.disabled}
      aria-label={item.label}
      className={cn(
        'w-full flex items-center gap-3 px-2 py-1.5 rounded text-sm transition-colors',
        item.disabled
          ? 'opacity-60 cursor-not-allowed text-text-muted'
          : 'text-text-primary hover:bg-bg-hover cursor-pointer',
        collapsed && 'justify-center',
      )}
    >
      <Icon size={16} className="shrink-0" />
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.span
            key="label"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="flex-1 text-left truncate"
          >
            {item.label}
          </motion.span>
        )}
        {!collapsed && item.shortcut && (
          <motion.span
            key="shortcut"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="text-[11px] text-text-muted shrink-0"
          >
            {item.shortcut}
          </motion.span>
        )}
        {!collapsed && item.disabled && (
          <motion.span
            key="lock"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="text-text-disabled shrink-0"
          >
            <Lock size={12} />
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  );

  if (item.disabled || collapsed) {
    const tooltipLabel = item.disabled
      ? 'Coming soon'
      : `${item.label}${item.shortcut ? ` (${item.shortcut})` : ''}`;
    return (
      <Tooltip>
        <TooltipTrigger asChild>{row}</TooltipTrigger>
        <TooltipContent side="right">{tooltipLabel}</TooltipContent>
      </Tooltip>
    );
  }
  return row;
}

// ── RecentSection ──────────────────────────────────────────────────────────────

function RecentSection({ onRenameProject }: { onRenameProject: (p: Project) => void }) {
  const list      = useConversations((s) => s.list);
  const currentId = useConversations((s) => s.currentId);
  const open      = useConversations((s) => s.open);
  const projects  = useProjects((s) => s.list);

  // IDs that belong to any project — excluded from flat list
  const projectedIds = new Set(projects.flatMap((p) => p.conversation_ids));
  const flatList     = (list ?? []).filter((c) => !projectedIds.has(c.id));

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
    >
      <div className="flex items-center justify-between px-2 mb-1">
        <span className="text-[11px] uppercase tracking-wider text-text-muted select-none">
          Recent
        </span>
      </div>

      {/* Project folder rows */}
      {projects.map((project) => (
        <ProjectRow
          key={project.id}
          project={project}
          allConvs={list ?? []}
          currentId={currentId}
          onOpen={open}
          onRename={onRenameProject}
        />
      ))}

      {/* Flat conversations */}
      <div className="space-y-0.5 mt-1">
        {flatList.length === 0 && projects.length === 0 && (
          <div className="px-2 py-1 text-xs text-text-disabled">No conversations yet</div>
        )}
        {flatList.map((c) => (
          <RecentRow key={c.id} conv={c} currentId={currentId} onOpen={open} projectId={null} />
        ))}
      </div>
    </motion.div>
  );
}

// ── ProjectRow ─────────────────────────────────────────────────────────────────

function ProjectRow({
  project, allConvs, currentId, onOpen, onRename,
}: {
  project: Project;
  allConvs: ConversationSummary[];
  currentId: string | null;
  onOpen: (id: string) => Promise<void>;
  onRename: (p: Project) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const convMap = new Map(allConvs.map((c) => [c.id, c]));
  const projectConvs = project.conversation_ids
    .map((id) => convMap.get(id))
    .filter(Boolean) as ConversationSummary[];

  const handleDelete = async () => {
    await useProjects.getState().delete(project.id);
  };

  return (
    <div className="mb-1">
      <div className="group flex items-center gap-1 px-1 py-1 rounded hover:bg-bg-hover">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1.5 flex-1 text-left text-sm text-text-secondary min-w-0"
        >
          {expanded
            ? <ChevronDown size={13} className="shrink-0 text-text-muted" />
            : <ChevronRight size={13} className="shrink-0 text-text-muted" />}
          <Folder size={13} className="shrink-0 text-text-muted" />
          <span className="truncate">{project.name}</span>
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Project options"
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-bg-hover text-text-muted hover:text-text-secondary shrink-0"
            >
              <MoreHorizontal size={14} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start">
            <DropdownMenuItem onClick={() => onRename(project)}>
              Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => void handleDelete()}
              className="text-red-400 focus:text-red-400"
            >
              <Trash2 size={13} />
              Delete project
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {expanded && (
        <div className="pl-4 space-y-0.5">
          {projectConvs.length === 0 && (
            <div className="px-2 py-1 text-xs text-text-disabled">Empty project</div>
          )}
          {projectConvs.map((c) => (
            <RecentRow
              key={c.id}
              conv={c}
              currentId={currentId}
              onOpen={onOpen}
              projectId={project.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── RecentRow ──────────────────────────────────────────────────────────────────

function RecentRow({
  conv, currentId, onOpen, projectId,
}: {
  conv: ConversationSummary;
  currentId: string | null;
  onOpen: (id: string) => Promise<void>;
  projectId: string | null;
}) {
  const navigate = useNavigate();
  const projects = useProjects((s) => s.list);
  const isActive = conv.id === currentId;

  const handleDelete = async () => {
    await useConversations.getState().delete(conv.id);
  };

  const handleAddToProject = async (pid: string) => {
    await useProjects.getState().addChat(pid, conv.id);
  };

  const handleRemoveFromProject = async () => {
    if (!projectId) return;
    await useProjects.getState().removeChat(projectId, conv.id);
  };

  return (
    <div className={cn('group flex items-center rounded transition-colors', isActive ? 'bg-bg-active' : 'hover:bg-bg-hover')}>
      <button
        type="button"
        onClick={() => { navigate('/chat'); void onOpen(conv.id); }}
        className={cn(
          'flex-1 text-left px-2 py-1.5 text-sm truncate',
          isActive ? 'text-text-primary' : 'text-text-secondary',
        )}
      >
        {conv.title}
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Chat options"
            className="opacity-0 group-hover:opacity-100 p-1 mr-1 rounded hover:bg-bg-hover text-text-muted hover:text-text-secondary shrink-0"
          >
            <MoreHorizontal size={13} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start">
          {projectId ? (
            <DropdownMenuItem onClick={() => void handleRemoveFromProject()}>
              <FolderMinus size={13} />
              Remove from project
            </DropdownMenuItem>
          ) : (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={projects.length === 0}>
                <FolderInput size={13} />
                {projects.length === 0 ? 'No projects yet' : 'Add to project'}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {projects.map((p) => (
                  <DropdownMenuItem key={p.id} onClick={() => void handleAddToProject(p.id)}>
                    <Folder size={13} />
                    {p.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => void handleDelete()}
            className="text-red-400 focus:text-red-400"
          >
            <Trash2 size={13} />
            Delete chat
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```powershell
cd frontend-react && npx tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 3: Run the frontend test suite to ensure no regressions**

```powershell
cd frontend-react && npx vitest run 2>&1
```

Expected: all existing tests pass (the changes add new state to `useUI` without removing anything; existing tests should be unaffected).

- [ ] **Step 4: Commit**

```bash
git add frontend-react/src/components/layout/Sidebar.tsx
git commit -m "feat(sidebar): project folders, chat context menus, New Project dialog, enable Search"
```

---

## Task 9: End-to-end smoke test

- [ ] **Step 1: Build the Tauri app**

```powershell
cd frontend-react && npm run build 2>&1
```

Expected: build succeeds with no TypeScript errors.

- [ ] **Step 2: Start the dev app and manually verify**

```powershell
npm run tauri dev 2>&1
```

Checklist:
- [ ] "New Project" sidebar button opens a dialog, entering a name and pressing Create adds a folder row in the Recent section
- [ ] Project folder collapses/expands on click
- [ ] A chat's `...` menu shows "Add to project" submenu listing the created project
- [ ] After adding, the chat disappears from the flat list and appears under the project folder
- [ ] A chat inside a project shows "Remove from project" instead of "Add to project"
- [ ] Project `...` menu shows Rename and Delete project; deleting returns chats to flat list
- [ ] Search button (and `Ctrl+K`/`⌘K`) opens the search overlay with blurred background
- [ ] Typing in the search overlay returns matching conversations by title instantly
- [ ] Clicking a result closes the overlay and opens the conversation

- [ ] **Step 3: Commit final**

```bash
git add -A
git commit -m "feat: Projects & Search — specs 5 & 6 complete"
```
