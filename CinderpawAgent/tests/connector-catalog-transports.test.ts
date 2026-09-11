/**
 * A catalog card must never promise a connection the sidecar cannot make.
 *
 * The catalog is Rust (`crates/cinderpaw-core/src/connectors.rs`) and the
 * transports are TypeScript (`src/transports/registry.ts`). Neither language's
 * tests can see the other side, so `coming_soon` has been a hand-kept claim
 * with nothing checking it. The registry's own header records what that cost:
 *
 *   "a connector that shipped in the catalog but not in those branches simply
 *    did nothing on a stranger's machine — enabled in the file, absent in the
 *    process, no message anywhere."
 *
 * The committed golden is the one artifact both sides share, so this is the
 * one place the two halves can be compared. Importing the barrel runs every
 * `registerTransport(...)` call as a side effect, which is how the list of
 * live transports is obtained rather than re-declared here — a second list
 * would be a second thing to forget.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registeredTransports } from "../src/transports/registry.ts";
// Side-effect imports: each module registers its transports on load.
import "../src/transports/connectors.ts";
import "../src/transports/matrix.ts";
import "../src/transports/mattermost.ts";
import "../src/transports/twitch.ts";

interface CatalogEntry {
  id: string;
  transport: string;
  coming_soon: boolean;
  pairing_method: string;
  pairing_fields: Array<{ key: string; secret: boolean }>;
}

const GOLDEN = join(
  import.meta.dir,
  "../../crates/cinderpaw-core/tests/testdata/connector_catalog.golden.json",
);

function catalog(): CatalogEntry[] {
  return JSON.parse(readFileSync(GOLDEN, "utf8")) as CatalogEntry[];
}

describe("catalog entries and live transports agree", () => {
  test("every wireable connector has a transport registered", () => {
    const live = new Set(registeredTransports());
    const promised = catalog().filter((e) => !e.coming_soon);
    const broken = promised.filter((e) => !live.has(e.transport));

    // Named in the failure, not just counted: the whole point is that the
    // person who added the card is told which one they forgot.
    expect({ broken: broken.map((e) => e.id) }).toEqual({ broken: [] });
    expect(promised.length).toBeGreaterThan(0);
  });

  test("every registered transport has a catalog entry", () => {
    // The other direction: a transport nobody can enable is dead weight that
    // still runs its imports at boot.
    const ids = new Set(catalog().map((e) => e.transport));
    const orphans = registeredTransports().filter((t) => !ids.has(t));
    expect({ orphans }).toEqual({ orphans: [] });
  });

  test("a coming_soon connector is one we have not built yet, not one we broke", () => {
    // Guards the lazy way out: flipping `coming_soon` to true to silence the
    // first test would hide a transport that exists and stopped being
    // advertised. If the transport is live, the card must be live.
    const live = new Set(registeredTransports());
    const hidden = catalog().filter((e) => e.coming_soon && live.has(e.transport));
    expect({ hidden: hidden.map((e) => e.id) }).toEqual({ hidden: [] });
  });
});

describe("the imported platforms arrived intact", () => {
  test("all 21 OpenClaw platforms are in the catalog", () => {
    expect(catalog()).toHaveLength(21);
  });

  test("every entry that asks for a credential marks it secret", () => {
    // The manifests we extracted carry OpenClaw's own `sensitive` marking and
    // we took it as authoritative. This pins the half that matters here: a
    // field whose key names a token, secret or key must never be stored in
    // the clear because someone mistyped one boolean.
    const looksSecret = /TOKEN|SECRET|KEY|PASSWORD|SID/;
    const wrong = catalog().flatMap((e) =>
      e.pairing_fields
        .filter((f) => looksSecret.test(f.key) && !f.secret)
        .map((f) => `${e.id}.${f.key}`),
    );
    expect({ wrong }).toEqual({ wrong: [] });
  });
});
