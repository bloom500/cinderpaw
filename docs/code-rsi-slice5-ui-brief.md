# MiniMax M3 brief — Faza 2 Slice 5: "Pending patches" card (UI leaf)

Context: the code-RSI approval gate is live in the sidecar
(`FeralAgent/src/rsi/pending-patches.ts`) and the IPC below is FROZEN.
Your task is the React card only — mirror the "Receipts" pattern already
in `frontend-react/src/components/FeralDreamsPanel.tsx`.

## IPC (frozen — do not change shapes)

Tauri commands (already registered in `src-tauri/src/lib.rs`):
- `feral_code_patches_list()` — fire-and-forget; sidecar replies with one
  `code_patches` event.
- `feral_code_patch_resolve(patch_id: string, action: "approve"|"reject")`
  — sidecar replies with `code_patch_resolved` + a refreshed `code_patches`.

Events (arrive over `feral://agent-output`, exact shapes in
`FeralAgent/src/types.ts` under `code_patches` / `code_patch_resolved`):

```ts
{ type: "code_patches",
  patches: Array<{ id, status, score, rationale, affectedFiles, patch,
                   commitHash, createdAt, note? }>,
  manualWindowOpen: boolean,   // first-10 window (spec §2.5)
  appliedCount: number }
{ type: "code_patch_resolved", id, status, error? }
```

`status`: `pending | approved | rejected | applied | apply_failed | reverted`.
An approval auto-applies when the host has `FERAL_CODE_RSI_REPO` set; the
ack then reports `applied`/`apply_failed`. `approved` alone means "recorded,
live apply unavailable" — show `note`/`error` when present.

## The card

In `FeralDreamsPanel.tsx`, below Receipts: a "Pending patches" section.
- Fetch on mount + on `dream_cycle ended` (same reload trigger Receipts
  uses); subscribe to both events via the existing `events.ts` listener
  pattern (add `onCodePatches` / `onCodePatchResolved` alongside the
  current listeners).
- Per patch: status badge, score, rationale, affected files, relative
  time; the diff behind a collapsible `<details>` (monospace, no
  highlighting needed). Approve / Reject buttons only for `pending`.
- Header line: `appliedCount`/10 while `manualWindowOpen`, e.g.
  "3/10 manual approvals until auto-apply unlocks".
- Empty state: one quiet line ("No pending code patches").
- TS bindings: add the two commands to `frontend-react/src/lib/tauri/index.ts`
  following the `dreamNow` binding style.

## Definition of done

Frontend `bunx tsc --noEmit` clean + panel tests extended (mirror the
existing FeralDreamsPanel tests: render with fake patches, approve click
invokes `feral_code_patch_resolve` with the right args, empty state).
Do not touch sidecar/Rust files. Do not add dependencies.
