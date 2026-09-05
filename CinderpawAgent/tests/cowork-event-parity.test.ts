/**
 * The cowork `eventType` union is declared TWICE — once by the sidecar that
 * emits it (`CinderpawAgent/src/types.ts`) and once by the frontend that renders
 * it (`src/lib/tauri/index.ts`) — in two packages that never see each other's
 * types. Nothing made them agree.
 *
 * What drift costs here is not a type error, it is a lie on screen. The store's
 * status derivation (`stores/coworkTranscript.ts`) is a ternary chain that lists
 * the `running` kinds, then the `error` kinds, and treats **everything else as
 * `done`**. So a kind the frontend has never heard of does not fail loudly or
 * render as unknown: it renders as a COMPLETED exchange, with no text, because
 * the reducer's switch has no case for it either. A teammate's failure would be
 * drawn as a teammate's success.
 *
 * That is the exact failure the panel was patched for on 2026-09-05 ("three
 * failures the panel showed as success, or as nothing"), arriving by a different
 * road. The two unions are in sync today; this is what keeps them there.
 *
 * Lives in the sidecar suite rather than the frontend one on purpose: it is a
 * cross-package contract test, not a UI test, and the frontend tsconfig has no
 * Node types — putting it there meant either a new dependency or Node globals
 * in browser code, to check a file neither side renders.
 *
 * Same discipline the repo already uses at three other language boundaries:
 * `crates/cinderpaw-core/tests/protocol_drift.rs` (message types, Rust↔TS),
 * `secret-redaction-cases.json` (redaction formats, Rust↔TS), and
 * `rsi-code-patch-denylist-parity.test.ts` (patch denylist). This edge was the
 * one still uncovered.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Pull the string-literal members of the `eventType` union that immediately
 * follows `type: 'cowork_event'` (or `"cowork_event"`) in a TypeScript source.
 *
 * Deliberately textual. The whole point is to read the OTHER package's source
 * as a file, the way protocol_drift.rs reads protocol.ts — importing it would
 * make the two sides share a declaration, which is a bigger change than this
 * test is allowed to make, and would not work across the package boundary.
 */
function coworkEventTypes(source: string): Set<string> {
  // Comments go first, and not for tidiness: the union in types.ts is
  // interrupted by a `//` comment that itself contains a semicolon ("...an
  // inbound message; the three terminal kinds..."). Matching up to the first
  // `;` therefore stopped mid-union and read 6 of the 10 kinds — a parity test
  // that compares two truncated sets is worse than none, because it passes.
  // The second test in this file is what caught it.
  const clean = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  const anchor = /type:\s*['"]cowork_event['"]\s*;/.exec(clean);
  if (!anchor) throw new Error("no `type: 'cowork_event'` member found");

  const after = clean.slice(anchor.index + anchor[0].length);
  const field = /eventType\s*:\s*([\s\S]*?);/.exec(after);
  if (!field) throw new Error('no `eventType` field after the cowork_event tag');

  const members = field[1].match(/['"]([a-z_]+)['"]/g) ?? [];
  const out = new Set(members.map((m) => m.slice(1, -1)));
  if (out.size === 0) throw new Error('the eventType union parsed as empty');
  return out;
}

const REPO = join(import.meta.dir, '..', '..');

describe('cowork_event eventType — sidecar/frontend parity', () => {
  test('both packages declare the same set of kinds', () => {
    const sidecar = coworkEventTypes(
      readFileSync(join(REPO, 'CinderpawAgent', 'src', 'types.ts'), 'utf8'),
    );
    const frontend = coworkEventTypes(
      readFileSync(join(REPO, 'frontend-react', 'src', 'lib', 'tauri', 'index.ts'), 'utf8'),
    );

    // Named separately so a failure says WHICH side is behind, and therefore
    // which file the person has to open.
    const missingInFrontend = [...sidecar].filter((k) => !frontend.has(k)).sort();
    const missingInSidecar = [...frontend].filter((k) => !sidecar.has(k)).sort();

    expect(
      missingInFrontend,
      'the sidecar emits these and the frontend has never heard of them — each ' +
        'one currently renders as a COMPLETED exchange with no text. Add them to ' +
        'src/lib/tauri/index.ts AND give them a status in stores/coworkTranscript.ts',
    ).toEqual([]);
    expect(
      missingInSidecar,
      'the frontend renders these and nothing emits them — dead branches in the panel',
    ).toEqual([]);
  });

  test('the parser actually finds the union rather than passing on an empty set', () => {
    // A parity test that silently matched two empty sets would pass forever
    // while guarding nothing. Pin one known member and the current size.
    const sidecar = coworkEventTypes(
      readFileSync(join(REPO, 'CinderpawAgent', 'src', 'types.ts'), 'utf8'),
    );
    expect(sidecar.has('approval_requested')).toBe(true);
    expect(sidecar.size).toBeGreaterThanOrEqual(10);
  });
});
