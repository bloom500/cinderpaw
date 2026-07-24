/**
 * Custom-tool runner — the CHILD side of an agent-authored tool call.
 *
 * The sidecar spawns itself with `--custom-tool-runner <module>` to execute
 * one custom tool (see `custom-tools.ts` for the parent side). Running our
 * own binary is what makes the forge work on an end-user machine: a packaged
 * Feral embeds its Bun runtime, so there is nothing to find on PATH. The
 * previous design shelled out to `bun` or `node` and silently disabled the
 * whole feature — including re-registering already-forged tools at boot —
 * on any machine without a JS runtime installed, i.e. every non-developer.
 *
 * Deliberately dependency-free and side-effect-free at import, and handled
 * before the CLI parser so a module path is never read as a subcommand. It
 * does NOT skip the agent's own module-graph startup, though — see the
 * ponytail note at the call site in `index.ts` for why, and what it costs.
 *
 * Wire contract (must stay in sync with `parseRunnerResult`): args arrive as
 * one JSON object on stdin, the result is the LAST JSON line on stdout —
 * anything the tool itself logs above it is ignored.
 */

import { pathToFileURL } from "node:url";

export const CUSTOM_TOOL_RUNNER_FLAG = "--custom-tool-runner";

interface RunnerResult {
  ok: boolean;
  content: string;
  data?: unknown;
  error?: string;
}

/** Execute one tool module and write its result line to stdout. Never
 *  throws: a module that blows up is reported as a structured failure,
 *  because the parent distinguishes "tool failed" from "no result at all"
 *  and only the latter should look like a crash. */
export async function runCustomToolModule(modulePath: string): Promise<void> {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;

  let result: RunnerResult;
  try {
    if (!modulePath) throw new Error(`${CUSTOM_TOOL_RUNNER_FLAG} needs a module path`);
    const mod = (await import(pathToFileURL(modulePath).href)) as {
      default?: (args: unknown) => unknown;
    };
    if (typeof mod.default !== "function") {
      throw new Error("tool module must have a default export function");
    }
    const raw = await mod.default(input.trim() ? JSON.parse(input) : {});
    result =
      raw && typeof raw === "object"
        ? {
            ok: (raw as RunnerResult).ok !== false,
            content: String((raw as RunnerResult).content ?? ""),
            ...((raw as RunnerResult).data !== undefined ? { data: (raw as RunnerResult).data } : {}),
          }
        : { ok: true, content: String(raw ?? "") };
  } catch (err) {
    result = {
      ok: false,
      content: String((err as Error)?.stack || err),
      error: "tool_error",
    };
  }

  // Bun.write (not process.stdout.write) so the bytes are flushed before the
  // caller exits the process — a truncated result line reads to the parent
  // as "the tool produced nothing", which is a different, misleading error.
  await Bun.write(Bun.stdout, "\n" + JSON.stringify(result));
}
