# SkillHub Drawer — Design Spec
**Date:** 2026-05-31  
**Status:** Approved  

---

## Overview

A slide-in drawer that lets users discover, preview, install, and manage AI agent skills directly inside Feral. The drawer overlays the app without leaving the current page. Skills can come from multiple providers; v1 ships local (installed) and GitHub (remote discovery) providers, with a ClawHub stub ready for later.

---

## Architecture

### Tech stack alignment
- **Frontend:** Leptos 0.6 (Rust, CSR), plain CSS, Tauri IPC via `tauri_bridge`
- **Backend:** Tauri commands in new `src-tauri/src/skills.rs` module
- **Persistence:** `~/.feral/skills/<slug>/SKILL.md` — Feral's own skill library
- **No dependency** on `~/.claude/skills/` or any Claude Code path

### Provider architecture

```rust
#[async_trait]
trait SkillProvider: Send + Sync {
    fn id(&self) -> &str;
    async fn list(&self) -> Result<Vec<SkillMeta>>;
}
```

Three providers:
| Provider | ID | Source | TrustLabel |
|---|---|---|---|
| `LocalProvider` | `"local"` | `~/.feral/skills/*/SKILL.md` | `Local` |
| `GitHubProvider` | `"github"` | JSON manifest at a hardcoded URL | `Community` |
| `ClawHubProvider` | `"clawhub"` | stub, returns `[]` | `Unknown` |

The manifest URL is a compile-time constant in `skills.rs`; can be promoted to a settings value later.

---

## Data Model

### `SourceProvider` (enum)
```rust
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum SourceProvider { Local, GitHub, ClawHub }
```

### `TrustLabel` (enum)
```rust
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum TrustLabel { Bundled, Local, Verified, Community, Experimental, Unknown }
```

### `InstallStatus` (enum)
```rust
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum InstallStatus { Installed, NotInstalled }
// Installing is transient frontend signal state only — never persisted
```

### `SkillMeta`
```rust
struct SkillMeta {
    id: String,                       // slug: [a-z0-9\-_]+ only
    name: String,
    description: String,
    author: String,
    version: String,
    license: String,
    tags: Vec<String>,
    source_provider: SourceProvider,
    source_url: Option<String>,       // repo/gist URL (display only)
    content_url: Option<String>,      // raw SKILL.md URL for fetch
    install_status: InstallStatus,
    trust_label: TrustLabel,
    last_updated: Option<String>,     // ISO date string if available
}
```

### `SkillPreview`
```rust
struct SkillPreview {
    meta: SkillMeta,
    content: String,   // raw SKILL.md text
}
```

---

## Backend Commands

All file operations validate:
1. `id` matches `^[a-z0-9\-_]+$` — rejects path components
2. Resolved final path starts with `~/.feral/skills/` — prevents traversal
3. `get_skill_content`-style calls only accept `https://` URLs from an allowlist (`raw.githubusercontent.com` + manifest domain)

| Command | Signature | Behavior |
|---|---|---|
| `list_installed_skills` | `→ Vec<SkillMeta>` | Scans `~/.feral/skills/`, reads SKILL.md frontmatter per entry |
| `get_installed_skill_content` | `id: String → String` | Reads `~/.feral/skills/<id>/SKILL.md` with path guard |
| `fetch_remote_skills` | `→ Vec<SkillMeta>` | GETs GitHub manifest JSON; sets `install_status` by cross-referencing local |
| `preview_remote_skill` | `url: String → SkillPreview` | Fetches URL (https-only, allowlisted hosts), parses SKILL.md frontmatter into meta + returns raw content |
| `preview_local_skill` | `path: String → SkillPreview` | Reads file at path (validated as a regular file), parses same way |
| `skill_exists` | `id: String → bool` | Checks if `~/.feral/skills/<id>/` exists |
| `install_skill` | `meta: SkillMeta, content: String, overwrite: bool → ()` | Writes `~/.feral/skills/<id>/SKILL.md`; errors if folder exists and `overwrite=false` |
| `remove_skill` | `id: String → ()` | Hard-deletes `~/.feral/skills/<id>/`; slug-validated + path-guarded |

> v2 note: soft-delete (move to `~/.feral/skills/.trash/`) is a natural follow-up to `remove_skill`.

---

## Frontend State

All state is local to the SkillHub drawer component (no new global context).

```
// Tab
active_tab: Tab  // Discover | Installed | Import

// Installed tab
installed_skills: Vec<SkillMeta>
installed_loading: bool
installed_error: Option<String>

// Discover tab
remote_skills: Vec<SkillMeta>
remote_loading: bool
remote_error: Option<String>

// Detail panel (shared across tabs)
selected_skill: Option<SkillMeta>
selected_content: Option<String>
selected_content_loading: bool
selected_content_error: Option<String>

// Install action (transient)
installing: Option<String>          // skill id being installed
overwrite_pending: Option<String>   // skill id awaiting overwrite confirmation
remove_pending: Option<String>      // skill id awaiting remove confirmation
```

---

## Drawer UI Structure

**Shell:** slides in from the right (~400px wide), overlays app content. `X` button closes. Toggled by the existing Skills button in the sidebar (currently a placeholder `<button>`; promoted to a proper toggle).

### Tab: Installed
- Fires `list_installed_skills` when the drawer opens.
- Cards: name, description, `TrustLabel` badge, "Details" button.
- Empty state: "No skills installed yet."
- Error state: message + retry button.
- Click "Details" → opens detail panel (lazy-loads content via `get_installed_skill_content`).

### Tab: Discover
- Fires `fetch_remote_skills` on first open (cached for the drawer session).
- Skeleton loader while `remote_loading`.
- Error state: message + retry button — does not affect Installed tab.
- Cards: same layout, badge shows `Community`, button says **"Preview"** (not Install).
- Already-installed skills show "Installed ✓" instead of "Preview".
- Click "Preview" → opens detail panel (lazy-loads content via `preview_remote_skill(content_url)`).

### Tab: Import
- Form: single text input labeled "Skill URL or local path", "Preview" button.
- URL path: calls `preview_remote_skill(url)`.
- Local path: calls `preview_local_skill(path)`.
- On success: detail panel opens with parsed metadata + content.
- On error: inline error below the input.

### Detail Panel
Replaces the list within the drawer (back arrow returns to list).

Sections:
1. Back arrow + skill name
2. Metadata row: author · version · license
3. Tags as pill badges
4. Trust badge + source link (if available)
5. SKILL.md content — rendered as preformatted text (no HTML injection)
6. Action button area (see flows below)

---

## Complete User Flows

### Discover → Install
1. Open Discover tab → `fetch_remote_skills` async → skeleton → cards render
2. Click "Preview" → detail panel opens, metadata shown, content loads async
3. Click "Install":
   - Call `skill_exists(id)`
   - If `false`: call `install_skill(meta, content, false)` → success → refresh both `installed_skills` and `remote_skills` (updates Discover statuses)
   - If `true`: show inline "A skill with this ID is already installed. Overwrite?" with Confirm / Cancel
   - Confirm → call `install_skill(meta, content, true)` → refresh both lists
4. Installing: show spinner on the Install button, set `installing = Some(id)`; clear on completion or error

### Installed → Remove
1. Open Installed tab → cards render
2. Click "Details" → detail panel, content loads async
3. Click "Remove" → inline "Remove this skill?" Confirm / Cancel
4. Confirm → `remove_skill(id)` → back to list → refresh `installed_skills` → also update `remote_skills` statuses

### Import (URL)
1. Import tab → paste `https://` URL → "Preview"
2. `preview_remote_skill(url)` → detail panel with meta + content
3. Same install flow as Discover → Install above

### Import (local path)
1. Import tab → paste or type local path → "Preview"
2. `preview_local_skill(path)` → detail panel with meta + content
3. Same install flow

---

## Security Constraints

| Concern | Mitigation |
|---|---|
| Path traversal | `id` regex + resolved path prefix check on every file op |
| Arbitrary URL fetch | `https://` only, allowlist: `raw.githubusercontent.com` + manifest domain |
| Remote code execution | SKILL.md displayed as preformatted text only — no eval, no script tags |
| Silent overwrite | Backend errors on `overwrite=false` if folder exists; frontend shows confirmation |
| Silent delete | `remove_skill` requires inline confirmation in UI before call |

---

## Files Affected

### New
- `src-tauri/src/skills.rs` — provider trait, LocalProvider, GitHubProvider, ClawHubProvider (stub), all command implementations
- `frontend/src/pages/components/skill_hub.rs` — drawer component, all tabs, detail panel

### Modified
- `src-tauri/src/lib.rs` — register 8 new commands + `mod skills`
- `frontend/src/pages/mod.rs` — `pub mod skill_hub` under components (already has `pub mod components`)
- `frontend/src/pages/components/mod.rs` — `pub mod skill_hub`
- `frontend/src/pages/components/sidebar.rs` — replace Skills placeholder `<button>` with drawer toggle
- `frontend/src/main.rs` — provide drawer open signal or pass toggle handler to sidebar
- `frontend/styles.css` — SkillHub drawer styles (shell, tabs, cards, detail panel, badges)

---

## What v1 Ships vs. What Is Stubbed

| Feature | v1 Status |
|---|---|
| Local installed skill browsing | Shipped |
| GitHub manifest remote discovery | Shipped |
| Preview before install | Shipped |
| Install to `~/.feral/skills/` | Shipped |
| Remove (hard delete) | Shipped |
| Manual import (URL + local path) | Shipped |
| Overwrite confirmation | Shipped |
| Remove confirmation | Shipped |
| ClawHub provider | Stub (returns `[]`) |
| Soft-delete / trash | Follow-up |
| Export skill to Claude Code dir | Follow-up |
| Skill enable/disable toggle | Follow-up |
| Ratings, comments, publishing, sync | Out of scope |
