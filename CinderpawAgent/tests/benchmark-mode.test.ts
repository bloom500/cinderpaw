/**
 * Benchmark mode — the two isolations a measured run needs (Val 2.3 / 2.4).
 *
 * 2.3 network: while a run is active, the only reachable hosts are
 *     CINDERPAW_BENCHMARK_ALLOW_HOSTS. Not "the tool's allowlist plus these" —
 *     instead of. Several tools ship an allowlist of `"*"`, so without this
 *     a benchmark can read a page containing the answer and the results file
 *     would look identical either way.
 * 2.4 data (invariant I13): the profile dir moves under runs/<runId>, so the
 *     skills, memory and DB of run N are not visible to run N+1.
 *
 * Both are read from the environment per call, so these cases must restore it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { benchmarkRunId, cinderpawHome, pickHomeDir } from "../src/config.ts";
import { EgressProxy, benchmarkHostRefusal } from "../src/egress/egress-proxy.ts";
import { hostOf } from "../src/egress/inference-router.ts";
import type { ToolManifest } from "../src/types.ts";

const SAVED = {
  run: process.env.CINDERPAW_BENCHMARK_RUN_ID,
  hosts: process.env.CINDERPAW_BENCHMARK_ALLOW_HOSTS,
  home: process.env.CINDERPAW_HOME,
};

afterEach(() => {
  for (const [k, v] of Object.entries({
    CINDERPAW_BENCHMARK_RUN_ID: SAVED.run,
    CINDERPAW_BENCHMARK_ALLOW_HOSTS: SAVED.hosts,
    CINDERPAW_HOME: SAVED.home,
  })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** A tool with the widest allowlist there is — the case that matters. */
const openTool: ToolManifest = {
  name: "fetch_url",
  description: "fetch_url",
  permissions: [],
  networkAccess: true,
  allowedDomains: ["*"],
};

function proxy() {
  return new EgressProxy(() => {}, {
    underlyingFetch: async () => new Response("ok", { status: 200 }),
  });
}

describe("2.3 — the network kill-switch", () => {
  test("off by default: an ordinary session is unaffected", () => {
    delete process.env.CINDERPAW_BENCHMARK_RUN_ID;
    expect(benchmarkRunId()).toBeNull();
    expect(benchmarkHostRefusal("anything.example.com", "tool")).toBeNull();
  });

  test("on: a host outside the allowlist is refused even for a `*` tool", async () => {
    process.env.CINDERPAW_BENCHMARK_RUN_ID = "run-1";
    process.env.CINDERPAW_BENCHMARK_ALLOW_HOSTS = "three.arcprize.org";
    const fetchFn = proxy().forTool(openTool, "s1");
    await expect(fetchFn("https://example.com/")).rejects.toThrow(/benchmark mode/);
  });

  test("on: an allowlisted host, and its subdomains, still work", async () => {
    process.env.CINDERPAW_BENCHMARK_RUN_ID = "run-1";
    process.env.CINDERPAW_BENCHMARK_ALLOW_HOSTS = "example.com";
    const fetchFn = proxy().forTool(openTool, "s1");
    const res = await fetchFn("https://example.com/");
    expect(res.status).toBe(200);
    expect(benchmarkHostRefusal("api.example.com", "tool")).toBeNull();
  });

  test("on with an empty allowlist: fail closed, and say which var to set", () => {
    process.env.CINDERPAW_BENCHMARK_RUN_ID = "run-1";
    delete process.env.CINDERPAW_BENCHMARK_ALLOW_HOSTS;
    const refusal = benchmarkHostRefusal("example.com", "tool \"web_search\"");
    expect(refusal).not.toBeNull();
    expect(refusal).toContain("CINDERPAW_BENCHMARK_ALLOW_HOSTS");
  });

  test("the model API is behind the same switch, not outside it", () => {
    // The inference router uses the global fetch and never touches the proxy;
    // a kill-switch that covered only tools would leave this exit open.
    process.env.CINDERPAW_BENCHMARK_RUN_ID = "run-1";
    process.env.CINDERPAW_BENCHMARK_ALLOW_HOSTS = "three.arcprize.org";
    expect(hostOf("https://openrouter.ai/api/v1")).toBe("openrouter.ai");
    expect(benchmarkHostRefusal(hostOf("https://openrouter.ai/api/v1"), "model")).toContain(
      "openrouter.ai",
    );
  });

  test("a malformed base URL is refused, not passed through as an empty host", () => {
    process.env.CINDERPAW_BENCHMARK_RUN_ID = "run-1";
    process.env.CINDERPAW_BENCHMARK_ALLOW_HOSTS = "example.com";
    expect(benchmarkHostRefusal(hostOf("not a url"), "model")).not.toBeNull();
  });

  test("a bad run id is refused loudly rather than mapped onto some directory", () => {
    process.env.CINDERPAW_BENCHMARK_RUN_ID = "../escape";
    expect(() => benchmarkRunId()).toThrow(/path-safe/);
  });
});

describe("the profile dir the sidecar picks agrees with the Rust host", () => {
  // The host migrates ~/.feral to ~/.cinderpaw on boot and reads the new one
  // from then on. The sidecar had ".cinderpaw" hardcoded, so after any migrated
  // boot the two halves read and wrote two different profiles — connectors
  // saved in one, invisible in the other, with no error anywhere.
  const MODERN = "/home/u/.cinderpaw";
  const LEGACY = "/home/u/.feral";

  test("both present (post-migration): the new one, same as the host", () => {
    expect(pickHomeDir(MODERN, LEGACY, true, true)).toBe(MODERN);
  });

  test("only the legacy one: use it — that is where this machine's data is", () => {
    expect(pickHomeDir(MODERN, LEGACY, false, true)).toBe(LEGACY);
  });

  test("fresh machine, neither exists: the new one", () => {
    expect(pickHomeDir(MODERN, LEGACY, false, false)).toBe(MODERN);
  });
});

describe("2.4 — per-run data dir (invariant I13)", () => {
  test("off: the profile dir is untouched", () => {
    process.env.CINDERPAW_HOME = join("/tmp", "cinderpaw-home");
    delete process.env.CINDERPAW_BENCHMARK_RUN_ID;
    expect(cinderpawHome()).not.toContain(`${"runs"}`);
  });

  test("on: each run gets its own dir, and two runs never share one", () => {
    process.env.CINDERPAW_HOME = join("/tmp", "cinderpaw-home");
    process.env.CINDERPAW_BENCHMARK_RUN_ID = "run-a";
    const a = cinderpawHome();
    process.env.CINDERPAW_BENCHMARK_RUN_ID = "run-b";
    const b = cinderpawHome();
    expect(a).toContain("run-a");
    expect(b).toContain("run-b");
    expect(a).not.toBe(b);
  });
});
