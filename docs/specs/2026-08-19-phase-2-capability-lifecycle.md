# Phase 2 — Capability Lifecycle

**Date:** 2026-08-19 · **Type:** implementation spec · **Status:** ready to implement

**Evidence baseline:** `docs/ui/2026-08-19-capability-install-current-state.md`
**UX contract:** `docs/ui/2026-08-19-ux-contract.md`

## Objective

Let Cinderpaw acquire a capability it does not have, on the user's instruction —
"install the thing that lets you read Excel files" — without ever letting the
agent decide what a capability is or where it came from.

## The rule this phase exists to enforce

> The agent may **request** a capability installation. It may never establish
> that capability's provenance, and it may never authorize its own install.

Today `do_install(meta, content, overwrite)` takes the file body, the metadata
and the trust label from its caller and applies only `validate_id` before
writing to disk. It is safe solely because its only caller is a UI drawer that
happens to be well behaved. Handing that function to the agent would mean the
agent supplies the code, the metadata, *and* the claim about where it came
from — self-authorization with extra steps.

## Non-goals

- `enable` / `disable`. There is no activation concept today — a skill is live
  because it is on disk. Inventing one here would be building a switch with
  nothing behind it.
- Version records, integrity hashes, update checking.
- Post-write content re-validation beyond "it parses and the id matches".
- OAuth or new connector providers. Connectors are capabilities with an auth
  step; that step is a later slice.
- Redesigning the Skills UI. `SkillHubDrawer` keeps working; only the function
  it calls changes shape.
- Touching MCP install. `mcp_install` already has the right shape and is the
  model this phase copies.

## Design

### D1 — The host resolves the name; the caller never supplies content

Copy the shape `mcp_install` already uses (`mcp.rs:923`): the caller names an
id, the host looks it up in **its own** catalogue and builds everything else
itself.

New host command:

```
install_capability(id: String) -> Result<SkillMeta, String>
```

1. `validate_id(&id)`
2. resolve `id` against the host's own manifests (`github_list()` +
   `community_list()`) — the caller cannot supply or influence the entry
3. take `content_url` **from the manifest entry**, never from an argument
4. `validate_content_url` — https + host allowlist — then fetch
5. **refuse a body that is not a SKILL.md** — empty, no frontmatter block, or
   no description. (An earlier draft called for "refuse if the body declares a
   different id". That check was written and then removed: SKILL.md frontmatter
   carries no id — the id is the directory name, supplied externally — so the
   comparison could never fail. It would have read as protection while
   providing none. What genuinely arrives on a bad `content_url` is a 404 page
   or an empty file, and writing one of those to disk while reporting a
   successful install is the real failure.)
6. stamp `trust_label` and `source_provider` from *which manifest matched*,
   discarding anything the caller said
7. write

`do_install` becomes private. Every path to disk goes through a function that
established provenance itself.

### D2 — The two UI paths fetch host-side too

The drawer currently fetches content in the UI and hands it back to the host.
Two thin commands replace that, each owning its own read:

```
install_skill_from_url(url: String)   // user pasted a URL
install_skill_from_file(path: String) // user picked a file
```

Both reuse the existing `fetch_remote_preview` / `preview_local_file`. Neither
is reachable from the agent — the user's own paste or file picker *is* the
provenance, and that is a claim only a human can make.

### D3 — Trust labels start telling the truth

`github_list` and `community_list` both stamp `TrustLabel::Community` today, so
the official Cinderpaw manifest and the community manifest are indistinguishable by
the time they reach the UI (evidence §6). Since Phase 2 makes the trust label
the thing an install decision is shown against, the official manifest becomes
`Verified` and the community manifest stays `Community`.

That is the minimum needed for the confirmation prompt to mean anything. The
remaining unused variants (`Bundled`, `Experimental`, `Unknown`) stay unused
and are not invented work.

### D4 — Three agent verbs, one of them an extension

| Verb | Shape | Notes |
|---|---|---|
| `list_skills` | **extended** with `source: "installed" \| "available" \| "both"` | Discovery. Today it lists only installed skills, so the agent cannot find a capability it does not already have. One argument beats a second tool. |
| `inspect_capability` | new — `{ id }` | Fetch and return the metadata, trust label and body **without installing**. This is the "inspect before trusting" step, and it lets the agent tell the user what it is about to add. |
| `install_capability` | new — `{ id }` | Requests the host install. Confirms with the user first. |

### D5 — The confirmation is mandatory and fails closed

`install_capability` confirms through the existing `ask_user` bridge before
requesting anything, following the precedent `control_app` sets
(`control-app.ts:20`): state-changing actions are confirmed, and when a
transport has no `askUser` bridge the action is **denied**, not silently
allowed. Adding software to someone's machine is at least as consequential as
clicking a button in their word processor.

The prompt names the capability, its source and its trust label — the three
things a person needs to answer the question.

### D6 — The bridge follows the two that exist

The sidecar reaches the host by emitting a request event and awaiting the
matching response, exactly as `desktop_control_request` (`types.ts:1454`) and
`rsi_request` (`types.ts:1466`) do:

```
{ type: "capability_request";  id: string; sessionId: string;
  action: "list" | "inspect" | "install"; params: Record<string, unknown> }
{ type: "capability_response"; id: string; ok: boolean; data?: unknown; error?: string }
```

All security gating lives in Rust. The bridge is transport-level RPC and makes
no decisions.

## Files

| File | Change |
|---|---|
| `src-tauri/src/skills.rs` | `install_capability`; `do_install` private; url/file wrappers; trust labels per manifest |
| `src-tauri/src/lib.rs` | register the new commands |
| `src-tauri/src/cinderpaw_agent.rs` (or the sidecar dispatcher) | handle `capability_request` |
| `CinderpawAgent/src/types.ts` | bridge events + `CapabilityBridge` |
| `CinderpawAgent/src/transports/tauri.ts` | wire the bridge |
| `CinderpawAgent/src/tools/builtin/capability.ts` | **new** — `inspect_capability`, `install_capability` |
| `CinderpawAgent/src/tools/builtin/list-skills.ts` | `source` argument |
| `CinderpawAgent/src/tools/builtin/index.ts` | register |
| `frontend-react/src/components/SkillHubDrawer.tsx` | call the new commands |
| `frontend-react/src/lib/tauri/index.ts` | new command signatures |

## Acceptance criteria

1. The agent can find, inspect and install a catalogue capability end to end
   from a plain-language request, with exactly one confirmation.
2. `do_install` is unreachable from outside the module; nothing writes a skill
   without the host having fetched it.
3. A fetched body that is not a SKILL.md (empty, no frontmatter, no
   description) is refused rather than written to disk.
4. A `content_url` outside the host allowlist is refused.
5. Declining the confirmation installs nothing.
6. No `askUser` bridge → the install is denied, not performed.
7. The official manifest yields `Verified`; the community manifest yields
   `Community`.
8. The Skills drawer still installs from catalogue, URL and file.
9. Existing skills tests still pass; `./scripts/verify.sh` passes.

## Tests to add

- Rust: non-SKILL.md body refused; disallowed host refused; `validate_id`
  still refuses traversal through the new entry point.
- Agent: `install_capability` denied without an `askUser` bridge; denied on a
  declined confirmation; the tool never passes content to the host.
- Agent: `list_skills` with each `source` value.
