/**
 * Projects (spec 9 of the UI design): a chat filed in a project carries the
 * project's instructions and its file list in the system prompt.
 *
 * The desktop host owns `projects.json` (src-tauri/src/projects.rs), and a
 * chat's session id is its conversation id, so the loop can find the project
 * itself, every turn: an edit to the instructions applies to the next message
 * and nothing new has to travel with each message. The files are copies under
 * `<profile>/workspace/projects/<id>/`, the one place in the profile the file
 * tools may read; the agent opens them when they matter.
 *
 * Never throws: an unreadable or malformed file is a turn without project
 * context, not a failed turn.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cinderpawHome } from "./config.ts";

/** Instructions past this are cut: a pasted book must not eat the context. */
export const PROJECT_INSTRUCTIONS_MAX = 8_000;

interface StoredProject {
  id?: unknown;
  name?: unknown;
  conversation_ids?: unknown;
  instructions?: unknown;
  files?: unknown;
}

export function projectAddendum(sessionId: string, home = cinderpawHome()): string {
  let list: unknown;
  try {
    list = JSON.parse(readFileSync(join(home, "projects.json"), "utf8"));
  } catch {
    return "";
  }
  if (!Array.isArray(list)) return "";
  const p = (list as StoredProject[]).find(
    (x) => Array.isArray(x?.conversation_ids) && (x.conversation_ids as unknown[]).includes(sessionId),
  );
  if (!p) return "";
  const instructions = typeof p.instructions === "string" ? p.instructions.trim().slice(0, PROJECT_INSTRUCTIONS_MAX) : "";
  const files = Array.isArray(p.files)
    ? (p.files as { name?: unknown; path?: unknown }[]).filter(
        (f): f is { name: string; path: string } => typeof f?.name === "string" && typeof f?.path === "string",
      )
    : [];
  if (!instructions && files.length === 0) return "";

  const lines = [`## Project: ${typeof p.name === "string" ? p.name : "Untitled"}`, "This chat is part of a project the person set up."];
  if (instructions) lines.push("", "Their instructions for every chat in this project:", instructions);
  if (files.length > 0) {
    lines.push(
      "",
      "The project's files. Open one with your file tools when it matters to the question; do not guess what is in it:",
      ...files.map((f) => `- ${f.name}: ${f.path}`),
    );
  }
  return lines.join("\n");
}
