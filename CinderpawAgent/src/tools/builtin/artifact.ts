/**
 * The artifact tools — six, and the count is the design.
 *
 * The obvious shape for this was fourteen verbs: document_create,
 * document_insert, document_replace_range, document_rewrite_section,
 * document_add_table, chart_create, chart_update, pdf_… and so on. That shape
 * is unaffordable here and `tools/tiers.ts` records why in numbers: every
 * advertised schema is re-sent on EVERY completion, 26 tools already cost 4,901
 * tokens of schema, and one measured task spent 317,000 of its 337,000 tokens
 * re-sending a prefix that never changed. Fourteen more would be the largest
 * schema regression this product has ever shipped.
 *
 * So the verbs collapse. `document_insert`, `document_replace_range` and
 * `document_rewrite_section` are one operation — replace a span with text —
 * differing only in which argument is supplied, and `artifact_edit` takes both
 * shapes. The model loses nothing: it could always express the intent, it just
 * has one door to express it through instead of nine.
 *
 * Two are core tier (`artifact_list`, `artifact_read`) because a task cannot
 * move forward without knowing what exists. The other four live in the drawer.
 *
 * SECURITY. Nothing here opens a new hole: every store write goes through
 * `artifactStoreGuard`, so `read_only` mode blocks an artifact edit and a path
 * cannot escape the artifact root. `artifact_export` is the only tool that writes outside it, and it can
 * only reach the workspace roots the user already granted.
 */

import type { Database } from "bun:sqlite";
import type { Tool, ToolManifest } from "../../types.ts";
import { resolve } from "node:path";
import {
  PermissionDeniedError,
  pathWithin,
  realpathBestEffort,
} from "../../egress/tool-permissions.ts";
import { permissionMode } from "../../core/permission-mode.ts";
import {
  ArtifactStore,
  isArtifactKind,
  type Artifact,
  type ArtifactKind,
} from "../../artifacts/store.ts";
import { APP_AUTHORING_BRIEF } from "../../artifacts/app.ts";
import { ArtifactExporter } from "../../artifacts/export.ts";
import {
  ensureWorkspace,
  getActiveWorkspaceId,
  getWorkspace,
} from "../../memory/workspaces.ts";

/**
 * The workspace an artifact belongs to, on a machine that has never been set up.
 *
 * `getActiveWorkspaceId` returns null until something has set one, which on a
 * fresh install is always — nobody has opened a directory yet. Falling back to
 * a named default (creating it if needed) means the first artifact a stranger
 * ever makes has somewhere to live, instead of failing with "no active
 * workspace", which is a sentence about our data model and not about anything
 * they did.
 */
export function activeWorkspaceId(db: Database): string {
  const active = getActiveWorkspaceId(db);
  // A stale pointer (the workspace was deleted) is the same situation as no
  // pointer at all, so check the row actually exists rather than trusting the id.
  if (active && getWorkspace(db, active)) return active;
  return ensureWorkspace(db, "default").id;
}

/** One line per artifact, the shape every listing uses. */
function line(a: Artifact): string {
  return `- ${a.id}  [${a.kind}] ${a.title}  (v${a.version}, ${a.bytes} bytes)`;
}

/**
 * The guard the store itself writes through.
 *
 * The store owns its own file writes, so the permission check has to reach
 * inside it rather than sitting in front of it — otherwise `read_only` mode
 * would be enforced by whichever tools remembered to ask, which is the kind of
 * promise that has exactly as many holes as there are callers.
 *
 * It does NOT go through `resolveAllowedPath`. That function's deny wall
 * refuses the whole profile dir, and the artifact root lives inside it, so the
 * first version of this guard refused every write on every install (17 Sep:
 * `artifact_create` failed twice with PermissionDeniedError). The wall is right
 * to stay whole for the agent's own fs tools, which pick their paths; exempting
 * `artifacts/` there would let `write_file` rewrite version bytes behind the
 * store's back. The store picks its own paths from a uuid, so it keeps the two
 * checks that still mean something here: `read_only` refuses a write, and the
 * realpath of the target must stay inside the root. It throws, and the registry
 * turns a throw into a structured tool error, so there is nothing to catch here.
 */
export function artifactStoreGuard(root: string): (path: string, mode: "read" | "write") => string {
  return (path, mode) => {
    if (mode === "write" && permissionMode() === "read_only") {
      throw new PermissionDeniedError(
        `read-only mode: the artifact store may not write "${path}".`,
      );
    }
    const target = realpathBestEffort(resolve(path));
    if (!pathWithin(target, realpathBestEffort(resolve(root)))) {
      throw new PermissionDeniedError(`path "${target}" is outside the artifact store`);
    }
    return path;
  };
}

export interface ArtifactToolDeps {
  db: Database;
  store: ArtifactStore;
  /** Where `artifact_export` is allowed to put a copy. */
  workspaceRoots: string[];
}

export function createArtifactCreateTool(deps: ArtifactToolDeps): Tool {
  const manifest: ToolManifest = {
    name: "artifact_create",
    description:
      "Put the result HERE instead of in the reply whenever it is longer than " +
      "about 15 lines, stands on its own, or is something the user will want to " +
      "edit, re-read or reuse after this conversation: a report, a summary, a " +
      "plan, a draft, a dataset, a script, an interactive chart or tool. Those " +
      "conditions are the instruction to call this: a long answer typed into " +
      "chat scrolls away and cannot be edited or exported. Returns a stable id " +
      "you can change later by name, from any surface: chat, a voice call, or a " +
      "connected chat app.\n\n" +
      "Kinds: document (prose, as HTML), markdown, app (see below), table (JSON " +
      "rows), code, json, html, file.\n\n" +
      "app = " + APP_AUTHORING_BRIEF + " Charts are apps: there is no separate " +
      "chart kind, because a chart is an app with no controls.",
    permissions: ["fs:write", "fs:read"],
    networkAccess: false,
    allowedPaths: [deps.store.root],
  };

  return {
    manifest,
    parameters: {
      kind: {
        type: "string",
        description:
          "document | markdown | chart | table | code | json | html | file. " +
          "Pick 'document' for prose the user will read, 'markdown' for notes.",
        required: true,
      },
      title: { type: "string", description: "Short human title, one line.", required: true },
      content: { type: "string", description: "The full content.", required: true },
    },
    async execute(args, ctx) {
      const kind = args.kind;
      if (!isArtifactKind(kind)) {
        return {
          ok: false,
          error: "bad_args",
          content: `artifact_create: unknown kind "${String(kind)}".`,
        };
      }
      if (!ArtifactStore.isTextKind(kind)) {
        return {
          ok: false,
          error: "bad_args",
          content:
            `artifact_create cannot author a ${kind} from text. ` +
            "Create the content as a 'document' and export it instead.",
        };
      }
      const title = typeof args.title === "string" ? args.title : "";
      const content = typeof args.content === "string" ? args.content : "";
      if (!title.trim()) {
        return { ok: false, error: "bad_args", content: "artifact_create: 'title' is required." };
      }
      if (!content) {
        return { ok: false, error: "bad_args", content: "artifact_create: 'content' is required." };
      }

      const a = deps.store.create({
        kind,
        title,
        content,
        workspaceId: activeWorkspaceId(deps.db),
        sessionId: ctx.sessionId,
        // Provenance, so a later "the report I made on WhatsApp" has something
        // to match on. The session id already encodes the surface.
        origin: { session: ctx.sessionId },
      });
      return {
        ok: true,
        content: `Created ${a.kind} "${a.title}" — id ${a.id} (v1, ${a.bytes} bytes).`,
        data: { id: a.id, kind: a.kind, title: a.title, version: a.version },
      };
    },
  };
}

export function createArtifactListTool(deps: ArtifactToolDeps): Tool {
  const manifest: ToolManifest = {
    name: "artifact_list",
    description:
      "List the durable artifacts (documents, reports, charts, tables, files) in " +
      "this workspace, newest first. Check here before making a new one — the user " +
      "often means something that already exists.",
    permissions: [],
    networkAccess: false,
  };

  return {
    manifest,
    parameters: {
      kind: { type: "string", description: "Optional filter, e.g. 'document'.", required: false },
      limit: { type: "number", description: "How many to return (default 50).", required: false },
    },
    async execute(args) {
      const kind = isArtifactKind(args.kind) ? (args.kind as ArtifactKind) : undefined;
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      const items = deps.store.list({
        workspaceId: activeWorkspaceId(deps.db),
        kind,
        limit,
      });
      if (items.length === 0) {
        // The fresh-install sentence. "No artifacts" states a fact about our
        // table; this states what to do about it.
        return {
          ok: true,
          content: kind
            ? `No ${kind} artifacts yet.`
            : "No artifacts yet — use artifact_create to make the first one.",
          data: { items: [] },
        };
      }
      return {
        ok: true,
        content: `${items.length} artifact(s):\n${items.map(line).join("\n")}`,
        data: { items },
      };
    },
  };
}

export function createArtifactReadTool(deps: ArtifactToolDeps): Tool {
  const manifest: ToolManifest = {
    name: "artifact_read",
    description:
      "Read an artifact's content by id, so you can answer about it or edit it " +
      "accurately. Pass `version` to read an older one.",
    permissions: ["fs:read"],
    networkAccess: false,
    allowedPaths: [{ path: deps.store.root, mode: "read" }],
  };

  return {
    manifest,
    parameters: {
      id: { type: "string", description: "The artifact id.", required: true },
      version: { type: "number", description: "Optional: an older version number.", required: false },
    },
    async execute(args) {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) return { ok: false, error: "bad_args", content: "artifact_read: 'id' is required." };
      const a = deps.store.get(id);
      if (!a) return { ok: false, error: "not_found", content: `No artifact with id ${id}.` };

      const version = typeof args.version === "number" ? args.version : undefined;
      const content =
        version === undefined
          ? deps.store.read(id)
          : deps.store.readVersion(id, version);
      if (content === null) {
        return {
          ok: false,
          error: "not_found",
          content: `Artifact ${id} has no version ${String(version)}.`,
        };
      }
      return {
        ok: true,
        content,
        data: { id, kind: a.kind, title: a.title, version: version ?? a.version },
      };
    },
  };
}

export function createArtifactEditTool(deps: ArtifactToolDeps): Tool {
  const manifest: ToolManifest = {
    name: "artifact_edit",
    description:
      "Change part of an artifact without rewriting it. Either pass `find` + " +
      "`replace` (exact string swap, the usual case), or `content` to replace the " +
      "whole thing. Every edit makes a new version and the old ones stay, so this " +
      "is safe to do repeatedly and can be rolled back. Prefer find/replace: it " +
      "keeps the user's own edits to the rest of the document.",
    permissions: ["fs:write", "fs:read"],
    networkAccess: false,
    allowedPaths: [deps.store.root],
  };

  return {
    manifest,
    parameters: {
      id: { type: "string", description: "The artifact id.", required: true },
      find: { type: "string", description: "Exact text to replace.", required: false },
      replace: { type: "string", description: "What to put in its place.", required: false },
      content: { type: "string", description: "Replace the entire content instead.", required: false },
      rollback_to: { type: "number", description: "Restore this version (written forward as a new one).", required: false },
      note: { type: "string", description: "One line on what changed.", required: false },
    },
    async execute(args, ctx) {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) return { ok: false, error: "bad_args", content: "artifact_edit: 'id' is required." };
      const existing = deps.store.get(id);
      if (!existing) return { ok: false, error: "not_found", content: `No artifact with id ${id}.` };

      if (typeof args.rollback_to === "number") {
        const rolled = deps.store.rollback(id, args.rollback_to, ctx.sessionId);
        if (!rolled) {
          return {
            ok: false,
            error: "not_found",
            content: `Artifact ${id} has no version ${args.rollback_to}.`,
          };
        }
        return {
          ok: true,
          content: `Restored "${rolled.title}" to the content of v${args.rollback_to}, saved as v${rolled.version}.`,
          data: { id, version: rolled.version, title: rolled.title, kind: rolled.kind },
        };
      }

      const note = typeof args.note === "string" ? args.note : undefined;

      if (typeof args.content === "string") {
        const updated = deps.store.write(id, args.content, ctx.sessionId, note ?? "rewrote");
        return {
          ok: true,
          content: `Rewrote "${updated!.title}" — now v${updated!.version} (${updated!.bytes} bytes).`,
          data: { id, version: updated!.version, title: updated!.title, kind: updated!.kind },
        };
      }

      const find = typeof args.find === "string" ? args.find : "";
      if (!find) {
        return {
          ok: false,
          error: "bad_args",
          content: "artifact_edit: pass either 'find' + 'replace', or 'content', or 'rollback_to'.",
        };
      }
      const replace = typeof args.replace === "string" ? args.replace : "";
      const current = deps.store.read(id) ?? "";
      if (!current.includes(find)) {
        // Say how it failed, not just that it did: the model's next move is to
        // re-read and try a shorter anchor, and it can only choose that if it
        // knows the text was absent rather than the id being wrong.
        return {
          ok: false,
          error: "not_found",
          content:
            `artifact_edit: that exact text is not in "${existing.title}". ` +
            "Read it first (artifact_read) and match a shorter, unique snippet.",
        };
      }
      // First occurrence only. A blind replace-all is how a one-word anchor
      // silently rewrites a document in ten places the user never looked at.
      const next = current.replace(find, replace);
      const updated = deps.store.write(id, next, ctx.sessionId, note ?? "edited");
      return {
        ok: true,
        content: `Edited "${updated!.title}" — now v${updated!.version} (${updated!.bytes} bytes).`,
        data: { id, version: updated!.version, title: updated!.title, kind: updated!.kind },
      };
    },
  };
}

export function createArtifactExportTool(deps: ArtifactToolDeps): Tool {
  const manifest: ToolManifest = {
    name: "artifact_export",
    description:
      "Write a copy of an artifact to a real file the user can open or attach. " +
      "Without `dest` it lands in the workspace root under its own name. An " +
      "`app` gets its chart library inlined, so the file works offline.",
    // The real file access happens inside ArtifactExporter, which owns the
    // manifest that guards it. Declaring the permissions twice would let the
    // two drift, and the one that matters is the one at the write.
    permissions: [],
    networkAccess: false,
  };
  const exporter = new ArtifactExporter(deps.store, deps.workspaceRoots);

  return {
    manifest,
    parameters: {
      id: { type: "string", description: "The artifact id.", required: true },
      dest: {
        type: "string",
        description: "Optional absolute path (or filename) to write to.",
        required: false,
      },
    },
    async execute(args) {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) return { ok: false, error: "bad_args", content: "artifact_export: 'id' is required." };
      const a = deps.store.get(id);
      if (!a) return { ok: false, error: "not_found", content: `No artifact with id ${id}.` };
      const dest = typeof args.dest === "string" ? args.dest : undefined;
      const res = await exporter.run(a, dest);
      return {
        ok: true,
        content: `Exported "${a.title}" to ${res.path}.${res.note}`,
        data: {
          id, path: res.path, bytes: res.bytes,
          title: a.title, kind: a.kind, version: a.version,
        },
      };
    },
  };
}

export function createArtifactDeleteTool(deps: ArtifactToolDeps): Tool {
  const manifest: ToolManifest = {
    name: "artifact_delete",
    description:
      "Hide an artifact from the workspace. The content is kept and can be " +
      "restored by the user, so this is not a destructive delete.",
    permissions: [],
    networkAccess: false,
  };

  return {
    manifest,
    parameters: {
      id: { type: "string", description: "The artifact id.", required: true },
    },
    async execute(args, ctx) {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) return { ok: false, error: "bad_args", content: "artifact_delete: 'id' is required." };
      const a = deps.store.get(id);
      if (!a) return { ok: false, error: "not_found", content: `No artifact with id ${id}.` };
      deps.store.remove(id, ctx.sessionId);
      return {
        ok: true,
        content: `Removed "${a.title}" from the workspace. The content is kept and can be restored.`,
        data: { id, title: a.title, kind: a.kind, version: a.version },
      };
    },
  };
}

/**
 * Re-exported from `artifacts/export.ts`, where it lives next to the only code
 * that uses it. Kept reachable here because the test that pins the Windows
 * character rules imports it from this module.
 */
export { safeFileName } from "../../artifacts/export.ts";
