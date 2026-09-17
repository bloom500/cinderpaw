/**
 * The store's guard against the REAL deny wall, not a fake.
 *
 * The store's own tests inject NO_GUARD, and boot passed a guard that routed
 * through resolveAllowedPath. The artifact root lives under the profile dir,
 * which that wall denies, so every artifact_create on every install failed with
 * PermissionDeniedError while all the fakes passed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactStoreGuard } from "../src/tools/builtin/artifact.ts";
import { resolveAllowedPath } from "../src/egress/tool-permissions.ts";

const saved = { ...process.env };
afterEach(() => {
  for (const k of ["CINDERPAW_HOME", "CINDERPAW_PERMISSION_MODE"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function home(): Promise<string> {
  const h = await mkdtemp(join(tmpdir(), "cp-home-"));
  process.env.CINDERPAW_HOME = h;
  return h;
}

describe("artifactStoreGuard", () => {
  test("writes inside the artifact root under the profile dir", async () => {
    const root = join(await home(), "artifacts");
    const target = join(root, "abc", "v1");
    expect(artifactStoreGuard(root)(target, "write")).toBe(target);
  });

  test("the rest of the profile dir stays walled for ordinary tools", async () => {
    const h = await home();
    const manifest = {
      name: "write_file", description: "", permissions: ["fs:write" as const],
      networkAccess: false, allowedPaths: [h],
    };
    expect(() => resolveAllowedPath(manifest, "fs:write", join(h, "artifacts", "x"))).toThrow(/protected/);
  });

  test("refuses a path outside the root", async () => {
    const root = join(await home(), "artifacts");
    expect(() => artifactStoreGuard(root)(join(root, "..", "cinderpaw.db"), "write")).toThrow(/outside/);
  });

  test("read_only mode refuses writes, allows reads", async () => {
    const root = join(await home(), "artifacts");
    process.env.CINDERPAW_PERMISSION_MODE = "read_only";
    expect(() => artifactStoreGuard(root)(join(root, "a", "v1"), "write")).toThrow(/read-only/);
    expect(artifactStoreGuard(root)(join(root, "a", "v1"), "read")).toBe(join(root, "a", "v1"));
  });
});
