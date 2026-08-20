# Capability Installation — Current State

**Date:** 2026-08-19 · **Branch:** `ui/cinematic-shell` · **Type:** evidence, not design.

Constative record of how a capability gets onto the machine today: skills,
MCP extensions, and connectors. Every claim carries a file reference. **No
solutions are proposed here.** Input document for the Phase 2 spec; do not edit
this file to match later design decisions.

---

## 1. The three install paths, and who is trusted

| Capability kind | Entry point | What the caller supplies | What the host owns |
|---|---|---|---|
| Skill | `skills::install_skill` (`src-tauri/src/skills.rs:459`) | **id, metadata, trust label, and the whole file body** | only the target directory |
| MCP extension | `mcp::mcp_install` (`src-tauri/src/mcp.rs:923`) | an id, plus user-filled field values | the catalogue entry, the command, the args |
| Connector | `connectors_manage` tool (`CinderpawAgent/src/tools/builtin/connectors-manage.ts`) | provider id + secret values | the field schema per provider |

The two host-side commands have **opposite shapes**, and this is the central
fact of this document.

---

## 2. Trust machinery that already exists

`src-tauri/src/skills.rs` is not naive. It contains:

**HTTPS-only fetching with a host allowlist** — `skills.rs:12-30`

```rust
const ALLOWED_CONTENT_HOSTS: &[&str] = &[
    "raw.githubusercontent.com",
    "gist.githubusercontent.com",
];

fn validate_content_url(url: &str) -> Result<()> { … }
```

**Curated manifests served from the Cinderpaw repository** — `skills.rs:6-10`
`GITHUB_MANIFEST_URL` and `COMMUNITY_MANIFEST_URL` both point at
`raw.githubusercontent.com/bloom500/feral/main/skills/…`.

**Path-traversal rejection with tests** — `validate_id` (`skills.rs:88`).
Its unit tests assert that `../evil`, `../../etc/passwd`, `Has Spaces` and
`CamelCase` are all refused.

**A six-level trust vocabulary** — `TrustLabel` (`skills.rs:46`):
`Bundled · Local · Verified · Community · Experimental · Unknown`.

---

## 3. Where the machinery is not applied

`do_install` is the function that writes to disk (`skills.rs:378`):

```rust
pub fn do_install(meta: &SkillMeta, content: &str, overwrite: bool) -> Result<()> {
    validate_id(&meta.id)?;
    let skill_dir = skill_path(&meta.id)?;
    …
    std::fs::write(skill_dir.join("SKILL.md"), content)?;
    Ok(())
}
```

It calls `validate_id` and nothing else.

- `validate_content_url` is **never called on the install path**. The content
  does not have to have come from an allowed host, or from any host.
- `content` is a `&str` handed in by the caller. The host never sees where it
  came from and has no way to ask.
- `trust_label` is a field on the caller-supplied `SkillMeta`. Whatever the
  caller writes there is what gets recorded.

Today this is safe by **convention, not enforcement**: the only caller is
`SkillHubDrawer.tsx:139`, which passes content it obtained from
`preview_remote_skill` — which does validate the host (`skills.rs:300`). The
safety lives in the call site's discipline, not in the function that performs
the write.

---

## 4. The correct shape already exists, one file over

`mcp_install` (`src-tauri/src/mcp.rs:923`):

```rust
pub async fn mcp_install(state, id: String, values: HashMap<String, String>)
    -> Result<McpServerView, String>
{
    let def = catalog().into_iter().find(|d| d.entry.id == id)
        .ok_or_else(|| "Unknown extension.".to_string())?;
    …
}
```

The caller **names** a capability; the host **resolves** what that name means
from its own catalogue and builds the command and arguments itself. The caller
cannot supply an executable, an argument, or a definition. User-supplied
`values` are only substituted into placeholders the catalogue entry declared.

This is the same trust boundary `install_skill` lacks, implemented in the same
codebase, in the same style.

---

## 5. What the agent can and cannot do

Agent tools relating to capabilities (`CinderpawAgent/src/tools/builtin/`):

| Tool | Capability |
|---|---|
| `list-skills.ts` | enumerate locally installed skills |
| `read-skill.ts` | read one skill's body, with content filters |
| `tool-drawer.ts` | advertise/hide tools within a turn |
| `tool-forge.ts` | build a custom tool at runtime |
| `connectors-manage.ts` | `list` and `configure` connectors |

There is **no agent tool that installs a skill or an MCP extension**. Searched:
`install_skill` and `mcp_install` appear only in `src-tauri/` and in
`frontend-react/`, never in `CinderpawAgent/src/`.

`connectors-manage.ts` is the one place where the agent already changes the
machine's capability state. Its own header states the intent
(`connectors-manage.ts:5`): to handle "connect to my Discord, here's the token"
"instead of bouncing the user to the settings UI". It covers Discord and Slack,
and requires the user to paste a bot token obtained from a developer portal —
`connectors-manage.ts:30` instructs the user to visit "the Discord Developer
Portal (Bot → Reset Token)". There is no OAuth.

---

## 6. Trust labels in practice

Both remote list functions stamp the label themselves, after fetching:

- `github_list` (`skills.rs:225`) → `SourceProvider::GitHub`, `TrustLabel::Community`
- `community_list` (`skills.rs:263`) → `SourceProvider::ClawHub`, `TrustLabel::Community`
- `parse_frontmatter` (`skills.rs:168`) → `TrustLabel::Local`
- `preview_local_file` (`skills.rs:336`) → `TrustLabel::Unknown`

So of the six declared trust levels, **three are ever assigned**: `Community`
for anything remote, `Local` for a skill already on disk, and `Unknown` for a
file the user imports by hand. `Bundled`, `Verified` and `Experimental` are
declared, matched against in types, and never produced by any code path.

Notably, the *official* Cinderpaw manifest and the *community* manifest both
produce `Community`. The distinction the two URLs exist to make is erased
before it reaches the UI.

---

## 7. What happens after a write

`do_install` writes `SKILL.md` and returns `Ok(())`.

- No validation that the written file parses.
- No check that the frontmatter matches the metadata that was recorded.
- No activation step — a skill is live because it is on disk.
- No version or integrity record is stored alongside it.
- `do_remove` (`skills.rs:398`) deletes the directory.

There is no lifecycle beyond present/absent on the filesystem.

---

## 8. Existing content safety

`read-skill.ts` applies `FORBIDDEN_PATTERNS` when the agent reads a skill
(`read-skill.ts:32`), rejecting `<script>` and `<iframe>` among others. This is
a **read-time** filter in the sidecar, not an install-time one in the host, and
it protects the agent's own context rather than the machine.

---

## Summary of gaps, as gaps

1. `do_install` accepts caller-supplied content and trust metadata, and applies
   only `validate_id` before writing to disk.
2. `validate_content_url` exists and is not called on the install path.
3. Provenance is established at the call site (the UI), not at the trust
   boundary (the host).
4. The agent has no install verb at all, for skills or extensions.
5. Three of six `TrustLabel` variants are never assigned (`Bundled`,
   `Verified`, `Experimental`); official and community sources both resolve to
   `Community`.
6. No post-write validation, activation step, version record, or integrity
   record exists.
7. Connector setup requires a developer-portal token paste and covers two
   providers; there is no OAuth path.
8. `mcp_install` demonstrates the host-owns-the-definition shape that
   `install_skill` does not have.
