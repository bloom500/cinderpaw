/**
 * Renamed tools keep answering to their old name.
 *
 * A rename is invisible to the model, which reads the current schema, but not
 * to everything else that carries a tool name: a resumed session's history, a
 * user's hook or custom tool, a hand-written permission entry, and the model's
 * own prior knowledge of a widely-used name. The alias resolves in the
 * registry's `call`, so exactly one tool is registered and exactly one schema
 * is paid for, while the old spelling still lands.
 */

import { describe, expect, test } from "bun:test";
import { AuditLog } from "../src/egress/audit-log.ts";
import { EgressProxy } from "../src/egress/egress-proxy.ts";
import { RealProcessSandbox } from "../src/egress/process-sandbox.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { createComputerUseTool } from "../src/tools/builtin/computer-use.ts";
import type { Tool } from "../src/types.ts";
import { openDatabase } from "../src/db.ts";

function newRegistry(): { registry: ToolRegistry; db: ReturnType<typeof openDatabase> } {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db.raw);
  const egress = new EgressProxy(audit.logger);
  const ps = new RealProcessSandbox(audit.logger);
  return { registry: new ToolRegistry(egress, audit, ps), db };
}

describe("control_app → computer_use alias", () => {
  test("the registry exposes exactly one tool, under the new name", () => {
    const { registry, db } = newRegistry();
    registry.register(createComputerUseTool());

    const names = registry.list().map((t) => t.manifest.name);
    expect(names).toContain("computer_use");
    // The alias must not cost a second schema in every completion.
    expect(names).not.toContain("control_app");
    expect(names.filter((n) => n === "computer_use")).toHaveLength(1);
    db.close();
  });

  test("has() accepts the old name", () => {
    const { registry, db } = newRegistry();
    registry.register(createComputerUseTool());
    expect(registry.has("control_app")).toBe(true);
    expect(registry.has("computer_use")).toBe(true);
    db.close();
  });

  test("a call using the old name reaches the renamed tool", async () => {
    const { registry, db } = newRegistry();
    let reached = 0;
    const stub: Tool = {
      manifest: { name: "computer_use", description: "x", permissions: [], networkAccess: false },
      async execute() {
        reached++;
        return { ok: true, content: "done" };
      },
    };
    registry.register(stub);

    const res = await registry.call("control_app", { action: "list_windows" }, "s1");

    expect(res.ok).toBe(true);
    expect(reached).toBe(1);
    db.close();
  });

  test("an unknown name is still unknown — the alias is not a catch-all", async () => {
    const { registry, db } = newRegistry();
    registry.register(createComputerUseTool());
    expect(registry.has("control_apps")).toBe(false);
    const res = await registry.call("control_apps", {}, "s1");
    expect(res.ok).toBe(false);
    db.close();
  });

  test("the old name resolves to nothing when the tool is not registered", () => {
    // Desktop control is opt-in and OFF by default, so on a fresh install the
    // tool is absent. The alias must not claim a capability that is not there.
    const { registry, db } = newRegistry();
    expect(registry.has("control_app")).toBe(false);
    db.close();
  });
});
